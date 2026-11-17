# Reliable "has sound?" check, fast Media-bin thumbnails — design

Date: 2026-11-17 · Size: small change · Follows: build #88

## Why

On a lower-spec office PC (16 GB RAM) some videos come onto the timeline **without
their sound**: no "Show audio track" item, silent in preview and export. Importing
into the Media bin is also slow there. Reproduced and measured (2026-11-17):

- To decide whether a video has sound, `hasAudio` (`src/lib/waveform.ts`) decodes
  the **whole soundtrack in the browser** (`decodeAudioData`). On that PC this fails,
  every time, for an ordinary clip (`Anara by chef kk.mp4`: 175 MB, H.264 + AAC-LC
  stereo 44.1 kHz). The same clip decodes fine here, so it isn't the file or memory
  (~350 MB needed, 16 GB installed). The failure is swallowed and treated as "no
  sound", so the clip gets no sound layer. The real error can't be read there: the
  installed app has no developer console.
- Every Media-bin thumbnail and every size/length read first **copies the whole file
  into memory** (`getMediaUrl` → blob). Here a 1 GB video took ~10 s before its
  thumbnail could start; the sound check on it peaked at +5 GB; a 2.3 GB video
  crashed the app.
- Reading straight from the file works: the asset protocol serves byte ranges
  (206), a `<video crossOrigin="anonymous">` on the file URL gives size/length in
  ~20 ms and a thumbnail in ~60 ms for the 1 GB file, and `toDataURL` is allowed
  (checked in the dev app).

Not a regression of #86–#88: the check and its callers are the same as in #85.

## Goals

- **Decide "has sound" from the file's own track list**, read in the backend:
  MP4 / MOV / M4V store it in the `moov` box (each track's `hdlr` names its type;
  `soun` = sound). Only box headers are read, never the media data.
  - Other containers (MKV, WebM, AVI, OGV) or an unreadable header: fall back to
    today's browser check.
- **Size, length and thumbnail read straight from the file**, not from a whole-file
  copy. If drawing the thumbnail from the file URL is refused (the release build's
  origin could behave differently from dev), fall back to today's blob path.
  Throwaway `<video>`/`<audio>` elements are released after use.
- **When the browser can't decode a sound for its waveform**, draw a plain strip
  instead of nothing, and put the reason in its tooltip, so the next failing PC
  tells us what's wrong.

## Non-goals

- Playback still copies each timeline clip into memory (`getMediaUrl` in the
  preview's video pool / `AudioLayers`). That's what crashed on 2.3 GB; it's a
  bigger change and gets its own plan.
- No ffmpeg/ffprobe dependency (it's optional on users' PCs).
- Clips already added without sound stay that way; re-adding them gets the sound.

## Approaches

1. **Read the track list in Rust (chosen).** Instant, no memory, independent of the
   PC's browser decoders. Covers the common case (phone / camera / editor exports
   are MP4/MOV).
2. Use ffprobe. Rejected: not installed on every PC.
3. Keep the browser decode but retry / add a timeout. Rejected: it fails
   deterministically on that PC; retrying changes nothing.

## Decided

- Backend command `media_has_audio(path) -> Option<bool>`: `Some` when the track
  list was read, `None` when unknown (frontend falls back).
- The waveform's failure reason is kept per file and shown as the strip's tooltip:
  `Sound — waveform unavailable on this PC: <reason>`.

## Left to the builder

The strip's exact look; parser structure inside the stated rules.
