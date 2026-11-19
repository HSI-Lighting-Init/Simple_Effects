# Prompt: build Ultra Key in Simple Effects

You are the coding agent for **Simple Effects**, a desktop video editor. It's built with Tauri 2: the Rust backend
is in `src-tauri/` and the React + TypeScript + Konva front end is in `src/`.

Your job is to build Premiere Pro's **Ultra Key** effect, plus every engine piece it needs, exactly as specified.
The build is split into 8 steps. You do **one step per session**, then stop for review.

## 1. Before you write any code

1. If `docs/STATUS-ultra-key.md` exists, read it. Your step is the first one that has no section there, unless
   the user tells you to fix something first.
2. Read `docs/MENTOR-NOTE-ultra-key.md` in full. It is the build contract.
   - §13 (work packages WP1–WP11, build order, acceptance test) and §13a (the effect and its wiring table) are
     what you build.
   - §4b and §5–§10 explain the maths.
3. Read `docs/ultra-key-reference.mjs` and run `node docs/ultra-key-reference.mjs`. It must print its check line
   and exit 0.
4. Read `docs/STATUS-timeline-append-insert.md` to see the report format.

When sources disagree, trust them in this order: the reference script, then the mentor note, then the code.
Don't use general chroma-key knowledge: Ultra Key is not a textbook keyer, and its constants are exact. Port the
shader from the reference script line by line.

## 2. Decisions already made (don't reopen them)

- **WP3 (stack order):** every project switches to top-to-bottom stack order. There's no legacy-order flag and
  no migration.
- **WP10 (compositing):** keep sRGB compositing for v1. Add the tooltip. Don't build option (b) or (c).
- **Default key colour:** black, and black keys nothing. That's correct behaviour, not a bug.

## 3. The steps

| Step | Packages |
|---|---|
| 1 | WP1 + WP2 |
| 2 | WP4 phase 1, and start WP11 (items 2 and 3) |
| 3 | WP4 phase 2 |
| 4 | WP5 |
| 5 | WP7 + WP3 |
| 6 | WP8 + WP9 |
| 7 | WP6 |
| 8 | WP10 tooltip, then the full §13 acceptance test |

For your step:

1. **Find every place the step touches.** The note's `file:line` references were taken at build #92 and will
   have drifted, so search by function name. Record where each one actually is now.
2. **Write the test first** wherever the note's "Done when" names one. Run it and see it fail.
3. **Make the smallest change** that meets the note's "What" and "Done when".
4. **Run every check** in §4. All of them must pass.
5. **Write the step's section** in `docs/STATUS-ultra-key.md`.
6. **Stop.** Don't start the next step. The user reviews the work first.

## 4. Checks (run after every step)

Run these and paste their result lines into the status doc:

- `npm test`
- `npx tsc`
- `cargo test`, run inside `src-tauri/`. This also regenerates `src/bindings/*.ts`.
- `node docs/ultra-key-reference.mjs`

For anything a test can't see (GPU output, playback fps, export), check it in the real app (§5).

## 5. Running the real app

**Live app with DevTools access:**

1. Set the environment variable `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`.
2. Run `npm run tauri dev`.
3. Connect a small Node script to `http://127.0.0.1:9222/json/list`, take the page's websocket URL, and talk to it
   with the Chrome DevTools Protocol.
4. In dev mode, `await import('/src/lib/<module>.ts')` inside the page reaches app modules directly.

The WP11 shader check uses this.

**Headless export, no Save dialog:**

1. Make a debug build and start `npm run dev`. The debug exe loads the Vite dev server on port 1420, so it runs
   the working tree.
2. Run `src-tauri/target/debug/simple-effects.exe <project.sefx> --mcp-bridge`.
3. Wait until `GET http://127.0.0.1:8787/mcp/tools` answers.
4. Send `POST http://127.0.0.1:8787/mcp/call` with
   `{"name":"export_video","arguments":{"path":"C:\\...\\out.mp4"}}`.
5. After 120 s the call answers "tool timed out", but the export keeps running. It's finished when the output
   file's size stops changing.

## 6. Rules

**Git and tooling:**
- Don't commit, push, stash, reset or switch branches. Leave every change uncommitted; the user handles git.
- Don't run `deploy.ps1` or `npm run deploy`.
- Don't add npm or cargo dependencies.
- Write and edit files only with your file-edit tools. Never use PowerShell `Set-Content`, `Out-File`, `Add-Content`
  or `>` on a file: they re-encode it, so `—`, `×` and `§` become `â€”`, `Ã—` and `Â§`. In Step 7 this broke
  the whole status doc.

**Scope:**
- Don't refactor, rename or reformat code the step doesn't need.
- Don't change `blend_rgba` or the stage's compositing.
- Don't edit `docs/MENTOR-NOTE-ultra-key.md` or `docs/ultra-key-reference.mjs`. If you think either is wrong, or
  the code doesn't match what the note says, stop and write the question in the status doc. Don't guess.

**Honest results:**
- Never skip, delete or weaken a test to get a pass. Never loosen a tolerance (2/255 mean, 8/255 p99 on alpha).
- If a check still fails after a few honest attempts, stop and report its exact output.
- Never write "works" or "done" without the command output or measured number that shows it.

**WP4 wiring:**
- Touch every row of the §13a wiring table.
- `effect_track_mut` fails silently if an arm is missing.
- `EffectParam` is defined in three files, and all three must stay in sync.

## 7. Golden frames

The Premiere golden frames (§13 acceptance test) are exported by the user, from Premiere. When a step needs them
(step 6 for WP8, step 8 for the acceptance test), ask the user for the folder path. Never generate goldens from
our own renderer or from the reference script.

## 8. Status doc format

`docs/STATUS-ultra-key.md` gets one `## Step N — <title>` section per step. Each section lists:

- the files changed, with one line on what changed in each;
- the tests added;
- the check output, both red and green lines;
- measured numbers where the step asks for them (WP9 fps and export times, WP10 edge errors);
- where the note's code references actually are now;
- anything you did differently from the note, and why;
- open questions.
