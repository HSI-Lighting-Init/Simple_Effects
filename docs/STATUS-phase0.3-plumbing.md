# Status — Phase 0.3 (agent plumbing for current models)

Written for the mentor, per §0's loop. Code side of 0.3 is done and checked; one part of
its own "done when" needs a live API call with a real key, which I can't do myself (BYO
key, browser-side only) — see "What still needs you" below.

## What changed

All in `src/agent/` unless noted.

- **`providers.ts` `MODELS`**: `claude-opus-4-1`/`claude-sonnet-4-5` → `claude-opus-5-5`
  (default, kept first for extraction — vision + long tool loops) / `claude-sonnet-5` /
  `claude-haiku-4-5-20251001`. Note: I used the exact current API model-id strings, not
  the roadmap's shorthand (`claude-opus-5`, `claude-haiku-4-5`) — Opus 5.5 is the current
  flagship (Opus 5 is a step behind it, still priced separately) and the `-20251001` suffix
  on Haiku is required by the real API. Confirmed via platform.claude.com/docs on
  2026-09-26; flag if you intended something else.
- **Thinking blocks**: confirmed directly from Anthropic's docs — Opus 5.5/Sonnet 5 think
  by default (`display` defaults to `"omitted"`: empty `thinking` text, real `signature`),
  and *any* assistant turn followed by a tool result must replay its thinking blocks back
  unmodified or the next request 400s ("thinking blocks cannot be modified"). Fixed by
  storing the raw response `content` array on the turn (`AgentTurn.raw`) and replaying it
  verbatim instead of rebuilding from text + tool_use.
- **`max_tokens`**: 4096 → 16000 (Anthropic only — thinking tokens count against this
  ceiling even when hidden, so 4096 left too little room for real tool-loop turns).
- **Prompt caching**: one top-level `cache_control: { type: "ephemeral" }` on the request
  body — this is Anthropic's "automatic caching" mode; the server manages breakpoints
  itself as the (append-only) history grows, no manual per-block placement needed.
- **429/529 retry**: `fetchWithRetry` (shared by both providers) — honours `Retry-After`
  when present, else exponential backoff, up to 4 retries, abortable via the existing
  `AbortSignal` so Cancel still works mid-retry.
- **`ToolResult` text+image together**: was silently dropping `text` whenever `image` was
  set, in three places — `AnthropicProvider`'s `tool_result` content array, `bridge.ts`'s
  `toMcp`, and (partially) DeepSeek's tool-result note. All three now send both blocks
  when both are present. This is also why `audit_export`'s handler no longer strips its
  `sheet` — that was working around this exact bug (see the tool's old description).
- **Cost logging**: `providers.ts` exports `estimateCostUsd` (Anthropic per-model USD/MTok,
  hand-checked against platform.claude.com/docs/en/about-claude/pricing on 2026-09-26 —
  `// ponytail`-marked, it's an estimate for the log, not a bill). `orchestrator.ts`
  accumulates `usage` across turns and logs a running `📊 … in / … out / … cache-read —
  ~$… so far` line after every turn via the existing `onLog`, so it shows up in the
  Scenario panel's Activity log with no new UI.
- **`orchestrator.ts` `READONLY`**: checked every tool in `tools.ts` against the set —
  already complete (`get_timeline`, `list_media`, `list_effects`, `list_transitions`,
  `list_styles`, `validate_timeline`, `render_preview`, `contact_sheet`, `audit_export`).
  No new read-only tools exist yet to add. "maxCalls per mode (extraction ~150)" is
  deferred — there's no "mode" concept in the orchestrator yet; that's Phase 1 plumbing
  once extraction tools exist, not something to build ahead of need here.
- **`mcp_bridge.rs` `recv_timeout`**: already 120s. No change needed — this line item was
  already done (presumably in the same session that added the bridge).

## Checked

- `npx tsc --noEmit` — clean.
- `npm test` (vitest) — 253/253 green, unchanged from before this work.
- `npm run build` (tsc + vite build) — clean production build.
- No Rust files touched this pass, so `cargo test` wasn't re-run (nothing to invalidate).

## What still needs you

The roadmap's "done when" also wants an in-app run on `claude-opus-5-5` that completes
without 400s, with `cache_read_input_tokens > 0` from turn 2 (visible now as the
`cache-read` number in the Activity log's `📊` lines). That needs a real API call against
your own key (BYO, browser-side, never available to me) — I can't self-verify it. To
check: open Scenario → Video, pick Anthropic / `claude-opus-5-5`, run anything with at
least one tool call in it (so there's a turn 2), and watch the Activity log for a `📊` line
with a non-zero cache-read number and no error. If it 400s instead, the likely cause is the
thinking-block replay (`AgentTurn.raw`) — paste me the error text and I'll dig in.

## Not done (separate from 0.3, still open)

Roadmap v3.2 steps 2–3 from the §11.1 closure: recalibrating `audit_export` by fault
injection and making it duplicate-aware, and committing the five defensive fixes as
general hardening (the latter already landed in the `commit` you approved). Didn't start
step 2 this pass — flagging rather than assuming priority over 0.3.
