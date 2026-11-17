# Status — Reliable sound check, fast Media-bin thumbnails

Date: 2026-11-17 · Plan: `docs/superpowers/plans/2026-11-17-sound-check-and-bin-thumbnails.md`
Spec: `docs/superpowers/specs/2026-11-17-sound-check-and-bin-thumbnails-design.md`

All changes are uncommitted in the working tree.

## Task 1 — Read the track list (Rust)

- `src-tauri/src/mp4_tracks.rs` (new): `has_sound_track` walks MP4/MOV box headers
  (32-bit size, 64-bit size when size = 1, size 0 = to parent end), validates every
  4-byte type as printable ASCII, descends only `moov` → `trak` → `mdia` → `hdlr`,
  reads the handler bytes `8..12`, seeks past all other bodies, and gives up with
  `None` after 100 000 boxes. Malformed sizes / out-of-parent boxes → `None`.
- `src-tauri/src/lib.rs`: `mod mp4_tracks;`; new `media_has_audio` command
  (`BufReader`, IO error → `None`), registered next to `add_video_layer`.
- `src/lib/api.ts`: `mediaHasAudio(path): Promise<boolean | null>`.

Outputs:

- Red (Step 2): `error[E0425]: cannot find function \`has_sound_track\` in this scope`.
- Green (Step 4): `cargo test … --lib mp4_tracks` → `test result: ok. 8 passed; 0
  failed; …`; full run `test result: ok. 268 passed; 0 failed; 7 ignored; 0 measured;
  0 filtered out; finished in 5.65s` (260 + 8); `npx tsc --noEmit` exit 0.

Notes: the first implementation of `mdia_has_sound` scanned for a nested `mdia` box
instead of the `hdlr` children (4 sound tests returned `Some(false)`); fixed by
delegating to the `hdlr` scan. No change to the plan's rules.

## Task 2 — `hasAudio` asks the track list first; failures keep their reason

- `src/lib/waveform.ts`: `hasAudio` now calls `mediaHasAudio` (a rejection counts as
  unknown) and only decodes when it returns `null`. New `waveformError(src)` backed
  by a module-level reason map, set in each failing branch of `loadAudioPeaks`
  (`"Web Audio isn't available"`, `"no audio data decoded"`, `String(error)`) and
  cleared on a successful decode.
- `test/has-audio.test.ts` (new).

Outputs:

- Red (Step 2): `TypeError: waveformError is not a function`, and the backend-known
  `a.mp4` case returned false (`Tests 2 failed`).
- Green (Step 4): `Test Files 1 passed (1)` / `Tests 2 passed (2)`; full run
  `Tests 316 passed (316)` → `Tests 318 passed (318)` (316 + 2);
  `npx tsc --noEmit` exit 0.

## Task 3 — Size, length and thumbnails straight from the file

- `src/lib/media.ts`: header comment now says playback/export keep blob URLs while
  probes read the file directly. `getVideoMeta` / `getAudioMeta` use
  `convertFileSrc(path)` (no `crossOrigin`) and release the element on success and
  on error. New private `posterFrom(url, crossOrigin)` keeps today's poster logic
  (seek to `min(0.1, duration/2)`, 160 px wide, JPEG 0.7) and adds the 8 s no-frame
  timeout, releasing the element once settled. `getVideoPoster` tries
  `posterFrom(convertFileSrc(path), true)` and falls back to
  `posterFrom(await getMediaUrl(path), false)` on any rejection.
  `getMediaUrl` and the video pool are unchanged.

Checks:

- `npx tsc --noEmit`: exit 0. `npx vitest run`: `Tests 318 passed (318)` (including
  the unchanged `test/media-url.test.ts`).
- Manual check (Step 3): **not run** — the app window cannot be seen/operated here.
  - Large (≥ 500 MB) video's bin thumbnail within ~1 s: not run.
  - Import/add a no-sound video (Review Focus 3) and an MKV/WebM with sound
    (Review Focus 4), then check Show audio track: not run (both are covered at unit
    level: the Rust parser test `a_video_without_sound_is_false` and the
    `mediaHasAudio → null → decode fallback` path in `test/has-audio.test.ts`).
  - Review Focus 1 (release build's file-URL origin refused → blob fallback):
    not run; the fallback is implemented but unexercised here.

## Task 4 — A sound with no drawable waveform still shows, and says why

- `src/App.tsx`: the waveform effect stores `png ?? ""`, so `waveforms[src] === ""`
  means "sound exists, waveform couldn't be drawn".
- `src/components/Timeline.tsx`: an audio block or tucked strip with `""` renders the
  same element with `tl-wave-none` and no background image; the block `title` gains
  `\nSound — waveform unavailable on this PC: ${waveformError(src) ?? "unknown reason"}`
  for an audio block or a video block whose tucked sound is `""`. The strip keeps
  `pointer-events: none`; the tooltip lives on the block.
- `src/App.css`: `.tl-wave-none` is a flat translucent lane with a centre line.

Checks:

- `npx tsc --noEmit`: exit 0. `npx vitest run`: `Tests 318 passed (318)`.
- Manual check (Step 3): **not run** — a working video's waveform being unchanged,
  and a forced decode failure showing the plain lane with the reason in the tooltip,
  were not observed in the running app.

## Task 5 — Final verification

- `npx tsc --noEmit` → exit 0.
- `npx vitest run` → `Test Files 15 passed (15)` / `Tests 318 passed (318)`.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib` → `test result: ok. 268
  passed; 0 failed; 7 ignored; 0 measured; 0 filtered out; finished in 5.19s`.

`git status` (only plan-named files plus the pre-existing untracked items):

```
 M src-tauri/src/lib.rs
 M src/App.css
 M src/App.tsx
 M src/components/Timeline.tsx
 M src/lib/api.ts
 M src/lib/media.ts
 M src/lib/waveform.ts
?? docs/STATUS-sound-check-and-bin-thumbnails.md
?? src-tauri/src/mp4_tracks.rs
?? test/has-audio.test.ts
```

Pre-existing untracked (`installers/`, the two `*-Scenes.csv` files, and the
spec/plan docs) were left untouched. `src/bindings/` is unchanged.

Review Focus 2 (the low-spec PC and `Anara by chef kk.mp4`) and Review Focus 1
(release build) are for the user / reviewer and are **not run** here.

## Deviations / notes

- PowerShell blocked `npx.ps1`, so npm commands were run as `npx.cmd` with the same
  arguments (allowed by the Global Constraints).
- `waveformError` clears the stored reason on a successful decode, so it always
  reflects the last decode of that source.
- The 8 s poster timeout applies to each attempt (file URL, then blob fallback), so a
  stalled file-URL load costs 8 s before the blob attempt starts.
- Manual checks in Tasks 3 and 4 are reported as **not run**, and their plan
  checkboxes are left unticked.

## Reviewer verification (2026-11-17)

Code read in full. Checks run in the live debug app (Vite) and in a **release build**
(`npm run tauri build -- --no-bundle`, origin `http://tauri.localhost`), driven over
the WebView2 debug port.

**Fixed by the reviewer**
- `mp4_tracks`: a `moov` with no `trak` (compressed QuickTime `cmov`) returned
  `Some(false)` and would have stripped the sound. Now `None` (the browser check
  decides). Test `a_moov_without_tracks_is_unknown_not_silent` (red → green).
- `getVideoPoster`: the 8 s timeout fired whenever the file server was busy copying
  another clip for playback (not a real stall) and then fell back to a whole-file
  copy — the very thing this fix removes. Measured: import during a playback copy →
  timeout → 1 GB copy of the bin file. Now a timeout (30 s) gives up without the
  copy; only a load error or a refused draw falls back.

**Live checks — pass**
- Track list (1–4 ms each): Anara true · transition2 true · silent.mp4 false ·
  sound.mov true · sound.mkv null (fallback) · 1 GB mp4 true · fake.mp3 null.
- Added to the timeline: Anara, .mov, .mkv (fallback), 1 GB → sound + Show item;
  silent.mp4 → no sound (Review Focus 3, 4).
- 1 GB video's bin thumbnail: 0.22 s (was ~10 s). fake.mp3: plain lane, tooltip
  "Sound — waveform unavailable on this PC: EncodingError: Unable to decode audio
  data".
- **Release build (Review Focus 1):** importing big + silent + Anara with thumbnails
  took 172 ms, no whole-file fetch (direct draw allowed under tauri.localhost);
  Anara gets its tucked sound, silent.mp4 none.
- After the fixes: `tsc` 0 · vitest 318/318 · `cargo test --lib` 269 passed, 7 ignored.

**Not run:** Review Focus 2 — the low-spec PC (user).

**Found, out of scope (next plan):** while the app copies a clip into memory for
playback (`getMediaUrl`: video pool, `AudioLayers`, waveform decode), **every
backend call waits** — `get_project` took 7.7 s during a 1 GB copy here (idle: 3 ms).
So adding/editing stalls each time a large clip is loaded for playback, and the
waveform decode still needs ~5× the file size in memory. Fix: play/probe from the
file URL (range requests; drawing from it is allowed, shown above) instead of
whole-file blobs, and build waveforms without decoding the whole file in the page.
