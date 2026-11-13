# Subtitles: design

Date: 2026-11-13 · Status: waiting for approval · Branch: `feature/timeline-trim-comp-duration`

## Goal

A user can put subtitles on a video in Simple Effects in two ways:

1. **Import a subtitle file** they already have (SRT, WebVTT, ASS/SSA and the other common formats).
2. **Generate subtitles from the speech** in a video or audio clip on the timeline, offline.

The subtitles then sit on the timeline as ordinary text, so the user can **add effects to them**
(styles, letter animations, transitions) the same way as any other text layer. That last part is the
point of the feature. Subtitles that can't be styled and animated aren't worth building here.

## Decided

- **Each subtitle line is its own Text layer**, and all of a file's lines go in one Group named
  "Subtitles". Chosen over a single new "subtitles" layer kind (see Approaches).
- **ffmpeg does both the reading and the speech detection.** It's the same ffmpeg the app already
  finds and installs (`find_ffmpeg`, `install_ffmpeg` → winget `Gyan.FFmpeg`). No new Rust crate and no
  new npm package.
- **A "Copy look / Paste look" action** applies one text layer's look to every selected text layer,
  so styling 150 lines takes one paste.
- **Paste Look onto the "Subtitles" group restyles every line in it**, without opening the group.
  Chosen over leaving the lines loose on the timeline: the timeline stays tidy, and restyling all the
  lines, now or later, is always one paste. The cost is that the video isn't visible while you're inside
  the group, because the app shows only a group's own layers when you open it. To style a sample against
  the video, the user styles any text layer next to the video, copies its look, and pastes it onto the
  group.

## Approaches considered

| | How it works | Trade-off |
|---|---|---|
| **A. One Text layer per line, in a group (chosen)** | Import creates N Text layers inside a "Subtitles" group. Batch styling via Copy look / Paste look. | Reuses all existing text drawing, export, inspector and per-letter animation. Letter animations already restart per line because they're anchored to each layer's start and end. Cost: many layers, and restyling later means select-all + paste again. |
| B. One new "subtitles" layer kind holding all lines | Shared look set once, renders the cue that's active at time t. | Change-once-applies-everywhere, but a new layer kind needs new code in the model, renderer, export and inspector, plus a cue editor. Letter animations would need re-anchoring per cue. Giving one line its own look is hard. |
| C. A group whose children inherit a shared look | Like A, with inheritance. | The most complex of the three, and nothing else in the app works this way. |

For the libraries:

| Job | Chosen | Rejected and why |
|---|---|---|
| Read subtitle files | `ffmpeg -i <file> -f srt -` converts any format ffmpeg reads into SRT, then a small SRT reader in Rust | `aspasia`, `subtitler`, `subparse`, `fasrt` (Rust crates). Only worth adding if we later want to keep ASS styling (colours, positions). ffmpeg already covers the formats. |
| Speech → text | ffmpeg 8's `whisper` audio filter (whisper.cpp inside, MIT licence, offline) | A bundled `whisper-cli.exe` or `whisper-rs` crate: only needed for word-by-word timing (non-goal). Cloud APIs (OpenAI, Deepgram, AssemblyAI): cost money, upload the user's audio, not open source. Vosk: less accurate. Whisper in the web view (Transformers.js): large download inside the web view, slower. |

## What was verified on this machine (2026-11-13)

- The installed ffmpeg is `8.1.1-full_build-www.gyan.dev`. Its configure line includes
  `--enable-whisper`, `ffmpeg -filters` lists `whisper`, and decoders exist for `srt`, `subrip`,
  `webvtt`, `ass`, `ssa`, `microdvd`, `sami` and `mov_text`.
- A 16-second Windows-TTS speech clip run through
  `-af "whisper=model=ggml-tiny.en.bin:language=en:queue=20:destination=out.srt:format=srt" -f null -`
  produced a word-perfect SRT in about 6 seconds, model load included.
- Adding `max_len=20` split it into short lines (e.g. `Welcome to Simple` / `Effects. Today we`).
  It leaves the occasional punctuation glitch, like a line starting `, style the text`.
- Whisper's SRT numbers cues from **0**, not 1. The reader must not rely on numbering.
- ASS converted to SRT keeps inline markup. A sample came out as
  `<font size="20">{\an8}Hello <i>there</i>\nsecond line</font>`, and VTT gave `Hi <b>Bob</b> & co`.
  ffmpeg had already decoded the entity. The reader must strip `<…>` tags and `{…}` override codes.
- Not verified: long clips (whether `queue` chunk boundaries cut lines mid-word), GPU use, larger models,
  and macOS ffmpeg (Homebrew) having the filter.

## How it works

### 1. Reading SRT (shared by both paths)

One Rust function: SRT text → `Vec<Cue { start_ms, end_ms, text }>`.

- Split on blank lines. In each block, find the `HH:MM:SS,mmm --> HH:MM:SS,mmm` line and take every
  line after it as text. Ignore the index line, whether it's present or not and whatever it says.
- Strip `<…>` tags and `{…}` codes, trim each line, and keep line breaks as `\n`. Text layers already
  support multi-line content.
- Drop cues whose text ends up empty, or whose end time isn't after their start time.
- Accept `.` as well as `,` before the milliseconds, and tolerate CRLF and a UTF-8 BOM.

### 2. Cues → layers (shared)

- One Text layer per cue: `start_ms`/`end_ms` from the cue, name from `text_layer_name(content)`,
  everything else built the way `add_text_layer` builds a text layer.
- **Default subtitle look** (my call, adjustable once it's on screen): centred horizontally, at about 88%
  of comp height, size about 5.5% of the comp's **shorter side** (so 9:16 and 4:5 comps don't get
  oversized text), white text with a dark outline or shadow so it reads on any footage. Use whichever
  existing `style` / `layer_styles` fields give the outline or shadow.
- **Wrapping** (my call): text layers never wrap on their own, so break any cue line wider than ~90% of
  the comp width at word boundaries, measured with `text::shape`. Existing line breaks stay.
- All the cue layers go into one Group named **"Subtitles"**, built the way `combine_layers` builds one.
  One cue still gets a group, so the user always finds subtitles in the same place.
- The whole import is **one undo step**: one `state.snapshot` before any change.
- **Comp length:** follow the existing rule (`comp_is_fit`). If the comp fits its content, it grows to
  the last cue. If the user set the length by hand, it stays: cues that start after the end are
  dropped, and cues that run past it are trimmed to it. Say how many were dropped in the result
  message.

### 3. Import a subtitle file

- **File → Import Subtitles…** opens a file dialog filtered to `srt, vtt, ass, ssa, sub, smi, sami`
  (plus "All files"). TTML is left out: ffmpeg 8.1.1 can write it but has no reader. A VobSub `.sub`
  is pictures, not text, and fails in ffmpeg. The plain error message below covers it.
- Rust runs `ffmpeg -hide_banner -loglevel error -i <path> -f srt -`, captures stdout, then runs
  steps 1 and 2. Cues start at comp time 0, which is the file's own timing.
- On failure, show ffmpeg's stderr in plain words, e.g. "Couldn't read this subtitle file: …".
- Non-UTF-8 files (old SRTs are often Windows-1252): try ffmpeg's `-sub_charenc` only if real
  files fail. The builder should test one before adding anything.

### 4. Generate subtitles from speech

**Starting it:** right-click a Video or Audio layer → **Generate Subtitles from Speech…**. A small
dialog asks for:

- **Language:** "Auto-detect" (default) plus a short list, English first. This maps to `language=`.
- **Quality:** "Fast" (`ggml-base.bin`, multilingual, ~142 MB) or "Accurate"
  (`ggml-large-v3-turbo-q5_0.bin`, ~550 MB). Default is Fast.

**Model download (first use):**

- Models live in the app's data folder under `whisper-models/`. They download from
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/<file>` with `curl.exe`, the same way
  auto-update downloads (`quiet_command("curl.exe")`, `curl_error`).
- Download to a temporary name, check the size and a SHA-256 hash pinned in the code (reuse
  `check_download`), then rename. A bad or partial file never gets used. These values come from Hugging
  Face's `X-Linked-Size` / `X-Linked-ETag` headers. The ETag was confirmed to be the SHA-256 on
  `ggml-tiny.en.bin`.
  - `ggml-base.bin`: 147951465 bytes, `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe`
  - `ggml-large-v3-turbo-q5_0.bin`: 574041195 bytes, `394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2`
- Show the download as its own step with progress or a spinner, and allow cancelling it.

**Running it:**

- **Finding an ffmpeg with the filter** (my call): a transcription-only lookup, so export's choice of
  ffmpeg doesn't change. Try `find_ffmpeg()`. If that one's `-filters` output lacks ` whisper `, look for
  `ffmpeg.exe` under the winget Gyan package folder and test that one. If neither has it, say so, name
  the path that was checked, and offer **Update ffmpeg**. That runs `winget upgrade --id Gyan.FFmpeg -e`
  when Gyan is installed, or the existing `install_ffmpeg` when it isn't. A plain `winget install`
  doesn't upgrade an older pre-8.0 install, and `install_ffmpeg` reports success as soon as any ffmpeg
  exists.
- Only transcribe the part of the source the layer plays. Source in-point is `inMs`. Source length is
  `(end_ms - start_ms) × speed`. Pass `-ss <inMs> -t <srcLen>` before `-i`, then
  `-vn -af "whisper=model=<path>:language=<lang>:queue=20:max_len=<n>:destination=<tmp.srt>:format=srt" -f null -`.
  `n` is 42, the usual subtitle line length, for landscape comps, and 24 when the comp is taller than
  wide (my call). This keeps lines short in time as well as width. Wrapping (step 2) catches the rest.
- **No paths inside the filter string.** Run ffmpeg with its working directory set to the models
  folder, and pass only names the app picks: `model=ggml-base.bin`, `destination=transcript-<ms>.srt`.
  ffmpeg unescapes filter arguments twice, so the plain `C\:` form fails. The double-escaped and quoted
  forms both work, but an apostrophe in the user folder (`C:\Users\O'Brien`) would break them. Tested
  2026-11-13: relative names from a folder containing spaces work. The media file goes through `-i`,
  which needs no escaping.
- **Map times to the comp:** `comp_ms = layer.start_ms + cue_ms / speed`. Then run steps 1 and 2
  (no extra offset).
- Reversed clips (`reverse: true`): refuse with a clear message. Not worth handling.
- **Cancel and progress:** run through the same mechanism `cancel_export` uses, so Cancel kills
  ffmpeg and deletes the temp SRT. Show at least "Transcribing… (Cancel)". Real progress via
  ffmpeg's `-progress` output is the builder's call.

### 5. Copy look / Paste look

New actions for **text layers**, available everywhere and not just for subtitles. They go in the
layer right-click menu and the Edit menu, next to Copy Layer:

- **Copy Look** (one text layer selected, at the top level or inside a group) remembers its look.
- **Paste Look** applies it to:
  - every selected text layer, and
  - every text layer inside any selected **Group**, including groups nested inside it, without
    opening the group. This is how the user restyles all the subtitles at once.

What a "look" is: everything about the text layer **except** its content, id, name, start/end and
`parts` (per-glyph manual edits belong to that text):

- Text fields: `size, align, color, colorKeys, font, weight, italic, anim, animOut, decompose,
  style, animators, layerStyles, perChar3d, perCharRx, perCharRy, perCharSpread`
- Layer fields: `transform` **except position (`x`, `y`)**, plus `transitionIn`, `transitionOut`, `effects`.
  Each line keeps its own position, matching the existing "Paste effects + transform"
  (`apply_layer_style`). To move all subtitles, move the Subtitles group.

**Keyframe timing** (my call): keyframes are stored in absolute comp time, and subtitle lines vary
in length, so a plain shift by start would leave a fade-out keyed near the end of a 3 s line
stranded inside a 5 s one. Instead, each keyframe keeps its distance from whichever end of the source
it's nearer to:
- A key in the first half of the source stays the same time after the target's start.
- A key in the second half stays the same time before the target's end.
- Then clamp it into the target's span.

Letter animations (`anim`/`animOut`) and in/out transitions already follow each layer's own start
and end, so they need nothing. Those are the main effects people will put on subtitles. This rule
only matters for hand-keyed tracks. `for_each_track_mut` currently misses `colorKeys`, the animator
tracks and `style.tracking`/`baseline_shift`. Extend it to cover them, because other features need
that too.

**Copy Look stores a copy of the look** at copy time, not the source layer's id. That way it can be
pasted after moving into or out of a group, where the source layer isn't in scope.

Pasting is **one undo step** for all targets. Non-text layers in the selection are skipped, and so
are non-text children of a selected group.

## Non-goals (for this version)

- Word-by-word timing and highlight ("karaoke" captions). Needs the separate whisper.cpp program.
  Add it if users ask.
- Keeping ASS/SSA styling (colours, fonts, positions) from imported files. They import as plain text
  with the default look.
- Exporting subtitles as an SRT file, or as a separate toggleable track in the MP4. Everything is
  burned into the picture by the normal export.
- The in-app AI agent (`src/agent/tools.ts`) and MCP bridge getting subtitle tools.
- Editing subtitle text or timing in a special list editor. Users edit them as normal text layers.
- Pulling subtitle tracks embedded in MKV/MP4 files.
- TTML/DFXP files (ffmpeg has no reader for them).

## Anti-goals

- Anything that sends the user's audio to an outside service.
- Subtitles that can't take the same effects as other text.

## Constraints

- Windows first. macOS: if the ffmpeg found there lacks the filter, file import still works and
  speech detection shows the "filter missing" message. Don't block macOS on this.
- One undo step per import, generation and paste.
- Big models: the Accurate model is ~550 MB. Never download without the user asking, and never
  re-download one that's already there and verified.

## Tests to leave behind

Rust unit tests next to the existing ones in `lib.rs`:

- SRT reader: index starting at 0 or missing, `.` vs `,` milliseconds, CRLF + BOM, multi-line cues,
  stripping `<i>`/`<font>`/`{\an8}`, dropping empty cues.
- Time mapping: for a clip with `start_ms = 2000`, `inMs = 1000`, `speed = 2`, a cue 3000 ms into the
  trimmed audio lands at comp 3500 ms.
- Paste look: source 0–3000 ms with keys at 500 ms and 2800 ms, pasted onto a target 10000–15000 ms,
  gives the target keys at 10500 ms and 14800 ms.
- Paste look onto a group: every text child (and the text children of a nested group) gets the look.
  A non-text child is untouched.
- The whisper filter string contains no `\` or drive-letter `:` (relative names only).

## Left to the builder

- Exact default outline or shadow values for the subtitle look.
- Whether long clips need the Silero VAD model (`vad_model=`, ~1 MB extra download) to stop lines being
  cut at `queue` boundaries. Test a 2–3 minute real clip with the Fast model. Add VAD only if lines
  visibly split mid-phrase.
- Progress display detail for the download and transcription.
- Language list contents.

## Changes after the final code review (2026-11-13)

- **Encoding:** a subtitle file that isn't UTF-8/UTF-16 is read with `-sub_charenc CP<Windows ANSI code page>`
  (default CP1252). Without it ffmpeg silently dropped every non-UTF-8 cue.
- **Stacking:** lines are bottom-anchored (the last row sits at 88% height, extra rows grow upward). A line on
  screen with others takes the lowest free run of rows, using the font's real line height.
- **Speech:** Whisper's non-speech tags (`[Music]`, `(applause)`, `♪♪`) are dropped. Imported files keep theirs.
- **Languages:** Chinese and Japanese are removed from the list, because Vazirmatn has no CJK glyphs. Other
  scripts need a covering font pasted on with Paste Look.
- **Paste Look:** rows the new font makes wider than 90% of the frame are re-broken at spaces, and rows are
  never joined. Keys from the look's first half never land after the target's midpoint, and second-half keys
  never land before it. Keys are kept sorted.
- **Colour keys** (text, shape, grid) now move with their layer and can be moved, deleted and cleared like
  other keyframes.
