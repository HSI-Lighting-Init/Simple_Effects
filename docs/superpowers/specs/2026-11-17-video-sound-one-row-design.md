# Timeline: a video and its sound in one row, images in the sequence — design

Date: 2026-11-17 · Size: project · Follows: `2026-11-17-timeline-append-insert-design.md` (build #86)

## Why

Build #86 made added videos play one after another, but each video's sound is a
separate row placed directly above the video. A new clip is slotted above the
selected layer, and after an add the video is selected, so the next video lands
**between** the previous video and its sound row (seen in the user's screenshot:
`r1.2.mp4 audio`, `watermark audio`, `watermark video`, `r1.2.mp4 video`). The user
wants a video and its sound to always read as one clip:

- one row per video by default, with the sound inside it;
- right-click the clip → **Show audio track** to edit the sound on its own row,
  and **Hide audio track** to tuck it back;
- while hidden, the sound moves with the video; while shown, it can move on its own;
- a sound that was edited while shown **keeps that offset** once hidden again, and
  from then on moves with the video (user's words: "when a audio it edited. it
  should stay in that offset");
- images join the sequence too: placed at the end of the clips, like videos.

## Goals

### One row per video
- Adding a video that has sound (Media bin click, drag-drop, merge, AI assistant)
  creates the video **and** its sound, with the sound **tucked** into the video's row:
  no row of its own. The video's block shows the sound's waveform along its lower
  part, drawn over the sound's own time span (so an offset or a trim is visible):

  ```
  ┌───────────────────────────────────┐
  │ r1.2.mp4                          │
  │▁▂▅▇▅▂▁▂▃▆▇▆▃▂▁▂▅▇▅▂▁▂▃▆▇▆▃▂▁▂▅▇   │  ← its sound, tucked
  └───────────────────────────────────┘
  ```
- The sound still plays in the preview and is still in the export, exactly as today.
- Adding a video with its sound is **one** undo step (today it's two; with the sound
  hidden, the first Ctrl+Z would seem to do nothing).

### Show / hide the audio track
- Right-click a video clip or row whose sound is tucked → **♪ Show audio track**.
  The sound row appears **directly above its video**. It is now an ordinary audio
  row: move, trim, cut, volume, fades, all on its own.
- Right-click a video whose sound is shown, or right-click that sound row →
  **♪ Hide audio track**. The row disappears; the sound keeps exactly where it is
  (its offset from the video, its trims, volume, fades).
- A video with no linked sound shows neither item.
- Each is one undo step.
- If the shown sound was cut into several pieces, they all belong to the video:
  Show and Hide act on all of them together.

### While the sound is tucked, every edit of the video applies to it

| Edit to the video | What its tucked sound does |
|---|---|
| Move | moves by the same amount (offset kept) |
| Trim start / end | the same edge moves by the same amount; a start trim moves the sound's in-point too. Never past its own source's start/end, never shorter than the minimum clip length, never outside the comp |
| Razor cut at time *t* | cut at *t* too when *t* falls inside it. Pieces after *t* go with the video's second piece, pieces before with the first |
| Delete (key, ✕, menu, merge's clean-up) | deleted too |
| Duplicate | copied too; the copy is tucked into the video's copy |
| Speed | same speed; its length rescaled the same way as the video's, and its start offset from the video scaled the same way (offset × old speed ÷ new speed), so the same picture and the same sound stay together (my call; a literal "offset kept" would put a trimmed sound out of sync) |
| Reverse | same setting; its range is mirrored inside the video's range (start offset becomes the video's end minus the sound's end), so picture and sound stay together. No change when the two ranges line up (my call) |
| Eye (hide/show layer) | same setting — the row is one clip, so turning it off silences it (my call) |
| Combine into group | the sound does **not** go in: it comes out as its own row beside the group, still linked to the video. Sound inside a group doesn't play today, in the preview or the export, so tucking it into a group would silence it invisibly. After *Explode group* the video and the sound are side by side again and *Hide audio track* works (my call) |
| The make-room shift when a clip is inserted before it | shifts exactly when its video shifts, by the same amount (also when the sound starts before the insert point and the video after) |
| Placing a newly added video | arrives with it |
| Merge into one video | included, so the merged file keeps the sound |
| Replace media | the old file's sound comes out as its own ordinary row, no longer linked (my call: today's Replace leaves sound rows alone; this keeps that and never hides a stale sound) |
| Explode group | links inside the group are kept (ids don't change) |

The same applies whoever makes the edit: the timeline, the menus, keyboard
shortcuts, or the AI assistant (it edits through the same backend commands).

### While the sound is shown, it is independent
Edits to the video don't touch the shown sound and vice-versa, with two exceptions:
- Today's speed rule stays as it is: changing a clip's speed also retimes an audio
  layer with the same file and exactly the same range. That rule also covers rows
  in old projects.
- Deleting the video leaves the shown sound row in place, no longer linked (so it
  can't be "hidden" into a video that's gone).
- Razor-cutting the video re-links the shown sound pieces by position: a piece that
  starts at or after the cut now belongs to the video's second piece, the others
  stay with the first. Shown pieces are not cut (my call). So a later Hide tucks
  each piece into the part of the picture it plays under.

Duplicating a video whose sound is shown copies only the video (the sound is its
own row then; my call).

### The AI assistant
- It edits through the same backend commands, so tucked sounds follow its edits too.
- `get_timeline` keeps listing every layer and marks a tucked sound with the video
  it belongs to, so the assistant knows not to move it separately.
- The `add_media_layer` description says the sound is tucked into the video's row
  and moves, trims, cuts and is deleted with the video, so it must not re-time the
  sound itself; `set_audio` (volume, fades) still works on it.
- Direct edits to a tucked sound by id are allowed (they change its offset, the
  same as the user showing the track and dragging it). No new Show/Hide tool (my
  calls).

### New clips never land between a video and its shown sound
When a clip is added "above the selected layer" and the selected layer is a video
whose shown sound rows sit directly above it, or one of those sound rows, the new
clip goes above the top of that video + sound group.

### Images join the sequence
- A new image is **3 s** long (today: a quarter of the comp length). This is the
  backend default, so it applies on every path that adds an image: Media bin,
  toolbar *Open image*, *Insert image on shape*, the AI assistant (my call).
- **The sequence** = the video layers and the flat image layers (not pinned to a 3D
  shape) in the current scope. An image or video that covers the whole comp, like a
  logo, counts too, so the first click-add after it goes to the comp's end (as an
  overlay video already does in build #86; my call).
- Only the Media bin click and drag append and make room; toolbar *Open image*
  still drops at the playhead.
- Click-add an image → it starts where the latest-ending **video or image** ends,
  and layers starting at or after that point move later, exactly like a video
  click-add in build #86. No video or image yet → at the playhead, nothing moves.
- Drag an image from the Media bin → the insertion line snaps to the nearest
  **video or image** edge; release inserts it there and shifts later layers by 3 s.
- Videos follow the same rule: their sequence now includes images too (append
  after the latest-ending video or image; snap to video and image edges).
- Audio files, text and the AI assistant's adds are unchanged (playhead, or the
  exact pointer time for a dropped audio file; nothing shifts).

## Non-goals
- **Existing projects keep their separate audio rows as they are**: no link, no
  Show/Hide item, no automatic tucking on open. Only videos added from now on get
  the one-row behaviour.
- No sound controls in the Inspector for a tucked sound. To change its volume or
  fades, show the audio track.
- No change to how sound is played in the preview, exported, merged, or turned into
  subtitles: the sound stays an audio layer.
- Replace media doesn't bring in the new file's sound (it doesn't today either).
- No multi-row "tracks" model; the timeline stays one row per layer.

## Anti-goals (would be a failure even if it technically works)
- A tucked sound drifting out of sync with its video after any edit: the user can't
  see the sound row to notice or fix it.
- A sound left playing with no row anywhere (after delete, replace, grouping).
- A Ctrl+Z, or any other action, that seems to do nothing because what it changed is
  hidden.
- Old projects changing on open.

## Constraints
- Old `.sefx` files must load unchanged; the new fields default to "not linked".
- Rust is the source of truth for every edit (`src-tauri/src/lib.rs` commands).
  `src/bindings/*.ts` is generated by ts-rs during `cargo test`; never hand-edited.
- Each user action stays one undo step (`state.snapshot` once per command;
  `place_layer` folds into the add's step).
- WebView2 swallows HTML5 drag-and-drop; timeline drags use pointer tracking, as today.

## Approaches

1. **Keep the sound as its own audio layer, linked to its video, with its row
   hidden while tucked. (Chosen by the user.)** The audio layer gains a link to its
   video and a "tucked" flag. The timeline skips tucked rows. Every backend command
   that edits a video repeats the edit on its tucked sound in the same undo step.
   Preview, export, merge and subtitles are untouched, and the offset rule comes for
   free because the sound never changes form. The risk is an edit that forgets the
   sound, so the follow logic sits in one place in the backend with a test per edit.
2. **Fold the sound into the video clip while hidden, split it back out when
   shown.** Moving, deleting and duplicating carry the sound for free, but every
   sound consumer (preview player, export, fast merge, subtitles, Inspector, AI
   tools) would have to find sound inside video clips, and the offset would need a
   second copy of the sound's position and trim inside the clip. Rejected: it
   rewrites the most delicate part of the app (export) for a timeline feature.
3. *(Dropped early)* **Display-only grouping**: draw the video and its sound in one
   row but keep them as fully independent layers. It can't honour "moves with the
   video while hidden" without the same follow logic as 1, so it's 1 with extra
   rendering work.

## How (decided)

- **Data.** The audio layer kind gets two fields, both defaulting so old files load
  unchanged: a link to its video's layer id (none by default), and a `tucked` flag
  (off by default).
- **Who counts as tucked.** A sound is tucked only when its flag is on **and** its
  linked video is in the same layer list (the same group scope). Anything else is an
  ordinary row. This is the safety net: a sound whose video has gone always shows
  up as a row instead of playing invisibly.
- **Where the follow lives.** In the backend, inside the commands that edit a video
  (range set, place/insert shift, razor cut, delete, multi-delete, duplicate, speed,
  reverse, eye, combine, replace). One shared helper finds a video's tucked sounds;
  the range-follow and the cut are shared helpers too, so the move, trim and insert
  shift all go through the same code.
- **Adding a video** probes for sound first, then one backend call creates the
  video and its tucked sound together (one undo step). Placing the video carries the
  sound with it.
- **Show / Hide** is one new backend command taking the video or one of its sounds.
  Show turns the flag off on every sound linked to that video and moves those rows
  directly above it (keeping their order). Hide turns the flag on and changes
  nothing else.
- **Timeline.** Tucked rows are not drawn; the video block draws each tucked piece's
  waveform over that piece's span. Tucked sound edges are not snap targets. A move
  drag keeps the video **and** its tucked sound inside the comp (the pair stops
  together at 0 and at the comp end).
- **Merge into one video** adds each chosen video's tucked sounds to what it merges
  (next to today's same-file, same-range rule).
- **Combine into group** leaves a member video's tucked sound outside the group,
  with its tucked flag turned off (link kept).
- **Speed and reverse** re-place a tucked sound as in the edit table, so the same
  source time of picture and sound keeps playing at the same moment.
- **Duplicating a group** keeps the links inside the copy pointing at the copied
  videos (ids are reassigned when cloning).

## Left to the builder
- Field, helper and command names; where the TS helpers live.
- The waveform strip's exact height and look (lower part of the block, readable
  under the clip name).
- Exact clamping arithmetic, as long as the "never" limits in the edit table hold.
- Test structure, as long as every row of the edit table has a backend test.
