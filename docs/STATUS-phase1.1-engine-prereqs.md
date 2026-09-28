# Status — Phase 1.1 (engine prerequisites)

Written for the mentor, per §0's loop. All three 1.1 items done, checked (Rust + frontend
tests, tsc, production build) and live-verified through the MCP bridge on a rebuilt app —
no live API key needed for any of it, same approach as 0.3's verification.

## What changed

- **Keyframe easing.** `TransformEdit` gets an optional `easing: Option<Easing>` field.
  `upsert_key` (lib.rs) takes it as a 6th param: a *new* keyframe (or the seed key) uses
  it (default `EaseInOut`, the prior hardcoded behaviour); an *existing* keyframe's easing
  is only touched when the caller explicitly passes one — a plain value nudge doesn't
  silently reset whatever shape was already chosen for that segment. All ~23 call sites
  updated (`edit_keyframes` passes `edit.easing` through; everything else passes `None`,
  i.e. unchanged behaviour). `eval.rs`'s `ease()` is now `pub(crate)` for the Phase 2
  fitter. Exposed on the `set_keyframe` agent tool.
- **`add_effect{layerId, kind, params}`** replaces `apply_color`. Covers all 19
  `Effect::default_of` kinds (7 colour/blur + wipe + shinyclouds + 10 GPU overlays), not
  just the 7-kind colour subset — GPU effects (vignette, aurora, filmgrain, etc.) are now
  directly addable, not just reachable through a style pack. `params` is validated
  *locally* against a per-kind catalog before touching the project (unknown kind/param
  fails clean, no partial apply), then keyed via the existing `key_effect`. The per-kind
  param ranges are the Inspector's own `GPU_FX` table — moved from `Inspector.tsx` to
  `src/lib/effects.ts` and imported by both, so the tool and the UI can't drift apart.
  `list_effects` now reports all 19 kinds with their real params/ranges instead of just
  the 7-kind colour subset.
- **`replace_layer_media` `fit`**: `"contain"` (default, unchanged) or `"cover"`. A
  pre-existing crop always carries over as before regardless of `fit` — this is purely
  new behaviour for an *uncropped* image slot. Video targets always letterbox: `LayerKind
  ::Video` has no `crop` field in the data model, so there's nothing to cover-crop into —
  documented in the Rust doc comment rather than silently no-op'd. Not yet wired to any
  UI or agent tool (none existed calling this before either); that's Phase 1.3's apply
  skeleton, not 1.1.

## A roadmap ask I deliberately didn't implement, and why

1.1 asked to "check every keyframe of the slot for revealed edges and scale up by the
minimum that hides them" after a cover-fit replace. Traced the actual math: the rescale
is one uniform multiplier `r` applied to *every* keyframe via `mul_track`, chosen so
`new_source_px * r == old_source_px` (via `cover_crop`'s exact-aspect-match crop). That
makes `new_box(t) == old_box(t)` for *every* `t`, not just the instant `r` was computed
from — if the old animation never revealed an edge, the new one can't either, by
construction. A per-keyframe revealed-edge check would be dead code for this
implementation (nothing can reach the branch it'd fix). Didn't add it — flagging the
reasoning here instead of quietly skipping it, since it's a real deviation from the
roadmap text.

## Checked

- `cargo check` — clean. `cargo test --lib` — 100 passed (my `#[ignore]`d recheck test
  from 0.2 correctly shows as 1 ignored, not run by default).
- `npx tsc --noEmit` — clean. `npx vitest run` — 253 passed (one existing test referenced
  the now-renamed `apply_color`; updated it to `add_effect`, same intent).
- `npm run build` — clean production bundle.
- **Live, via the MCP bridge** (rebuilt to build #42, checkpointed your live project
  first, restored it after): `list_effects` reports all 19 kinds with the right params
  (checked vignette's exactly matches the Inspector's slider ranges); `add_effect` added
  a real vignette to a real layer with custom params, and cleanly rejected an unknown kind
  and an unknown param with clear error text; `set_keyframe` accepted a real `easing`
  value end-to-end through Tauri IPC and cleanly rejected an invalid one (`unknown variant
  'bounce'`), which also confirms the `Option<Easing>` field serializes correctly when
  present *and* when omitted — the one thing I couldn't be 100% certain of from reading
  the code alone. `replace_layer_media`'s `fit` isn't bridge-reachable (no tool wraps it
  yet), so that part rests on the Rust compile + the exact-math argument above.

## Not started

1.2 (`make_synthetic_reference` + `score_recovery`) and Gate A (the aligner spike) —
where actual inverse rendering starts existing. Next up.
