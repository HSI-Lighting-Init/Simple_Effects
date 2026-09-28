//! Phase 2.5: the keyframe fitter, shared by background and (once Phase 3
//! lands) per-element motion. Turns a densely-sampled channel (e.g. one of
//! `AlignSample`'s `scale`/`rotationDeg`/`tx`/`ty` columns) into a small set
//! of `model::Keyframe`s that reproduce it within tolerance — "how an editor
//! keys," not one keyframe per sample.
//!
//! Two ideas carry the whole module:
//! - **Shared key times across channels.** An editor keys a whole transform
//!   at once (one diamond, several parameters change together), so times are
//!   chosen ONCE across every channel passed in, by DP over ≤4 segments from
//!   curvature-peak candidates (plus any caller-supplied preferred times —
//!   annotated frames, once Phase 3 adds them). Each channel then gets its
//!   own values and easing at those shared times.
//! - **Hold falls out for free.** Rather than specially detecting "a single-
//!   frame scale step" (a punch-in), `Hold` is just another easing shape in
//!   the same least-SSE competition as `Linear`/`EaseIn`/`EaseOut`/
//!   `EaseInOut`/`Bezier` — a segment that's flat until the very last sample
//!   naturally scores best under `Hold`, no special case needed.

use crate::eval::cubic_bezier;
use crate::model::{Easing, Keyframe};

/// One channel of densely-sampled data to fit — e.g. `("scale", &scales)`.
/// `values[i]` must correspond to `times_ms[i]` (see `fit_channels`). `name`
/// isn't read inside this module (channels map to output by position, not
/// name) — it's here for the caller that assembles the result into named
/// `Transform` tracks (`fit_background`/`fit_element`, once one exists).
pub struct Channel<'a> {
    #[allow(dead_code)]
    pub name: &'a str,
    pub values: &'a [f32],
}

pub struct FitParams {
    /// DP considers at most this many segments (so at most `max_segments + 1`
    /// keys: the two span edges plus up to `max_segments - 1` interior ones).
    pub max_segments: usize,
    /// Cost penalty per segment (`lambda` * segment count, added to each
    /// segment's SSE normalized by its channel's own value-range² — see
    /// `channel_range` — so this is in scale-free "fraction of the channel's
    /// own range²" units, comparable regardless of whether a channel is
    /// pixels, degrees or a ~1.0 scale factor). Higher favours fewer keys.
    pub lambda: f32,
    /// How many curvature-peak candidates to offer the DP, beyond the two
    /// forced span-edge keys and any `preferred_times`.
    pub max_candidates: usize,
    /// A Bezier fit is only worth its extra parameters if it beats the best
    /// named easing's SSE by at least this fraction (parsimony — otherwise
    /// every segment would "fit better" with 4 free params and nothing would
    /// ever read as a plain `EaseInOut`).
    pub bezier_margin: f32,
}

impl Default for FitParams {
    fn default() -> Self {
        FitParams { max_segments: 4, lambda: 0.02, max_candidates: 16, bezier_margin: 0.2 }
    }
}

/// Fit every channel to a SHARED set of key times. `times_ms` must be sorted
/// and the same length as every channel's `values`. `span` is the shot/
/// element's own [start, end] — the fitter always keys exactly there (not
/// just the nearest sample), per the roadmap's "extrapolate to the span
/// edges." `preferred_times` (e.g. annotated frames) are folded in as
/// candidates the DP is biased to keep.
///
/// Returns one `Vec<Keyframe>` per input channel, same order, all sharing
/// their `time_ms` values.
pub fn fit_channels(
    times_ms: &[u32],
    channels: &[Channel],
    span: (u32, u32),
    preferred_times: &[u32],
    p: &FitParams,
) -> Vec<Vec<Keyframe>> {
    if times_ms.is_empty() || channels.is_empty() {
        return channels.iter().map(|_| Vec::new()).collect();
    }
    if times_ms.len() == 1 || span.1 <= span.0 {
        // Nothing to shape — one flat key per channel at its only value.
        return channels
            .iter()
            .map(|c| vec![Keyframe { time_ms: span.0, value: c.values[0], easing: Easing::Linear }])
            .collect();
    }

    let candidates = candidate_times(times_ms, channels, span, preferred_times, p.max_candidates);
    let mut chosen = select_key_times(&candidates, times_ms, channels, preferred_times, p);
    // Extrapolate to the span edges: the DP chose its two end nodes from the
    // real decoded sample range, which may fall a little short of the shot/
    // element's own boundaries — widen just the two edge keys out to them.
    // `value_at`/`best_easing` both tolerate a time outside `times_ms`'s own
    // range (nearest-sample fallback), so this is safe even at the very
    // first/last call.
    let last = chosen.len() - 1;
    chosen[0] = span.0;
    chosen[last] = span.1;

    channels
        .iter()
        .map(|c| {
            let mut keys = Vec::with_capacity(chosen.len());
            for (i, &t) in chosen.iter().enumerate() {
                let value = value_at(times_ms, c.values, t);
                let easing = if i + 1 < chosen.len() {
                    best_easing(times_ms, c.values, t, chosen[i + 1], p).0
                } else {
                    Easing::Linear // last key's easing is never sampled (nothing after it)
                };
                keys.push(Keyframe { time_ms: t, value, easing });
            }
            keys
        })
        .collect()
}

/// The value a channel would report at time `t`, from its actual samples —
/// keyframe VALUES are always real observations, never fit (only the shape
/// between them is). Nearest sample if `t` isn't exactly sampled (true at
/// the span edges, which are forced keys but not necessarily sample times).
fn value_at(times_ms: &[u32], values: &[f32], t: u32) -> f32 {
    let idx = match times_ms.binary_search(&t) {
        Ok(i) => i,
        Err(i) => {
            if i == 0 {
                0
            } else if i >= times_ms.len() {
                times_ms.len() - 1
            } else if t - times_ms[i - 1] <= times_ms[i] - t {
                i - 1
            } else {
                i
            }
        }
    };
    values[idx]
}

/// Curvature-peak candidate times: local maxima of the summed, per-channel-
/// normalized discrete second derivative — points where the combined motion
/// actually changes character, not every sample. Always excludes the span
/// edges (those are forced separately) and always includes `preferred_times`
/// that fall strictly inside the span.
fn candidate_times(times_ms: &[u32], channels: &[Channel], span: (u32, u32), preferred_times: &[u32], max_candidates: usize) -> Vec<u32> {
    let n = times_ms.len();
    let mut curvature = vec![0.0f32; n];
    for c in channels {
        let norm = channel_range(c.values);
        for i in 1..n.saturating_sub(1) {
            let d2 = (c.values[i - 1] - 2.0 * c.values[i] + c.values[i + 1]).abs() / norm;
            curvature[i] += d2;
        }
    }
    // A single-frame step (a punch-in) produces two equal, adjacent
    // curvature spikes (one on each side of the jump) — break the tie toward
    // the LATER sample (the jump's landing point), not the one before it, so
    // the segment ending there reads as flat-then-landed (a clean `Hold`)
    // rather than splitting one sample early into an awkward partial jump.
    let mut peaks: Vec<(u32, f32)> = (1..n.saturating_sub(1))
        .filter(|&i| curvature[i] >= curvature[i - 1] && curvature[i] > curvature[i + 1])
        .filter(|&i| times_ms[i] > span.0 && times_ms[i] < span.1)
        .map(|i| (times_ms[i], curvature[i]))
        .collect();
    peaks.sort_by(|a, b| b.1.total_cmp(&a.1));
    peaks.truncate(max_candidates);

    let mut out: Vec<u32> = peaks.into_iter().map(|(t, _)| t).collect();
    for &t in preferred_times {
        if t > span.0 && t < span.1 && !out.contains(&t) {
            out.push(t);
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

/// DP over ≤ `max_segments` segments: choose a subset of `candidates`
/// (always including both span edges) minimizing total SSE (summed across
/// every channel) + `lambda` per segment. State is (candidate index,
/// segments used so far) — small (≤ ~18 candidates × ≤4 segments).
///
/// A segment landing on a `preferred_times` entry (an annotated frame) pays
/// a fraction of the usual `lambda` — "preferred," not mandatory: it still
/// loses to a candidate that fits meaningfully better, but doesn't get
/// squeezed out just because an unannotated split was a hair cheaper.
fn select_key_times(candidates: &[u32], times_ms: &[u32], channels: &[Channel], preferred_times: &[u32], p: &FitParams) -> Vec<u32> {
    // Nodes span the real decoded sample range (segment cost needs `times_ms`
    // entries to look up values by); `fit_channels` remaps the first/last
    // chosen key out to the caller's actual span edges afterward.
    let mut times = Vec::with_capacity(candidates.len() + 2);
    times.push(times_ms[0]);
    times.extend(candidates.iter().copied());
    times.push(*times_ms.last().unwrap());
    times.sort_unstable();
    times.dedup();

    let n = times.len();
    const NEG: f32 = f32::INFINITY;
    // dp[i][s] = min cost of a path ending at node i having used s segments.
    let mut dp = vec![vec![NEG; p.max_segments + 1]; n];
    let mut back = vec![vec![usize::MAX; p.max_segments + 1]; n];
    dp[0][0] = 0.0;

    for i in 0..n {
        for s in 0..=p.max_segments {
            if dp[i][s].is_infinite() {
                continue;
            }
            if s == p.max_segments {
                continue; // no more segments allowed from here
            }
            for j in (i + 1)..n {
                let seg_lambda = if preferred_times.contains(&times[j]) { p.lambda * 0.1 } else { p.lambda };
                let cost = dp[i][s] + segment_sse(times_ms, channels, times[i], times[j], p) + seg_lambda;
                if cost < dp[j][s + 1] {
                    dp[j][s + 1] = cost;
                    back[j][s + 1] = i;
                }
                // Only the immediate-next few nodes matter for keeping
                // segments reasonably sized; trying every j keeps this
                // correct (not just greedy) since candidate counts are small.
            }
        }
    }

    let last = n - 1;
    let mut best_s = 1;
    for s in 2..=p.max_segments {
        if dp[last][s] < dp[last][best_s] {
            best_s = s;
        }
    }
    // Fall back to a straight line (2 keys) if nothing solved (shouldn't
    // happen — dp[last][1] is always reachable via the direct edge-to-edge
    // segment — but stay defensive).
    if dp[last][best_s].is_infinite() {
        return vec![times[0], times[last]];
    }

    let mut chosen = vec![last];
    let mut cur = last;
    let mut s = best_s;
    while s > 0 {
        let prev = back[cur][s];
        chosen.push(prev);
        cur = prev;
        s -= 1;
    }
    chosen.reverse();
    chosen.into_iter().map(|i| times[i]).collect()
}

/// A channel's own value range (max - min), floored at 1 so a flat channel
/// never divides by ~0. Channels are wildly different scales (pixels,
/// degrees, a 1.0-ish scale factor) — every cross-channel comparison in this
/// module (curvature ranking, and here) normalizes by this first so `lambda`
/// means the same thing regardless of which channels were passed in.
fn channel_range(values: &[f32]) -> f32 {
    let max = values.iter().cloned().fold(f32::MIN, f32::max);
    let min = values.iter().cloned().fold(f32::MAX, f32::min);
    (max - min).abs().max(1e-6)
}

/// Total SSE across every channel for the segment [lo, hi], each channel
/// using its own best-fitting easing (see `best_easing`) and normalized by
/// its own value range² — so `lambda`'s "is one more segment worth it"
/// tradeoff is in comparable, scale-free units across channels.
fn segment_sse(times_ms: &[u32], channels: &[Channel], lo: u32, hi: u32, p: &FitParams) -> f32 {
    channels.iter().map(|c| best_easing(times_ms, c.values, lo, hi, p).1 / channel_range(c.values).powi(2)).sum()
}

/// The lowest-SSE easing for one channel's samples in [lo, hi], among the 5
/// named shapes plus an optional Bezier fit (kept only if it clears
/// `bezier_margin` over the best named shape). Returns (easing, its SSE).
fn best_easing(times_ms: &[u32], values: &[f32], lo: u32, hi: u32, p: &FitParams) -> (Easing, f32) {
    let v0 = value_at(times_ms, values, lo);
    let v1 = value_at(times_ms, values, hi);
    let span = (hi - lo).max(1) as f32;

    // Interior samples strictly between lo and hi (the endpoints are pinned
    // to v0/v1 by construction, so they contribute ~0 to every shape alike).
    let interior: Vec<(f32, f32)> = times_ms
        .iter()
        .zip(values.iter())
        .filter(|&(&t, _)| t > lo && t < hi)
        .map(|(&t, &v)| ((t - lo) as f32 / span, v))
        .collect();

    let sse_of = |f: &dyn Fn(f32) -> f32| -> f32 {
        interior.iter().map(|&(u, v)| { let pred = v0 + (v1 - v0) * f(u); (pred - v).powi(2) }).sum()
    };

    let named: [(Easing, f32); 5] = [
        (Easing::Linear, sse_of(&|u| u)),
        (Easing::EaseIn, sse_of(&|u| u * u)),
        (Easing::EaseOut, sse_of(&|u| 1.0 - (1.0 - u) * (1.0 - u))),
        (Easing::EaseInOut, sse_of(&|u| u * u * (3.0 - 2.0 * u))),
        (Easing::Hold, sse_of(&|_| 0.0)),
    ];
    let mut best = named[0];
    for &cand in &named[1..] {
        if cand.1 < best.1 {
            best = cand;
        }
    }

    if interior.len() >= 3 && (v1 - v0).abs() > 1e-4 {
        let (bx1, by1, bx2, by2, bsse) = fit_bezier(&interior, v0, v1);
        if bsse < best.1 * (1.0 - p.bezier_margin) {
            best = (Easing::Bezier { x1: bx1, y1: by1, x2: bx2, y2: by2 }, bsse);
        }
    }
    best
}

/// Coordinate descent over the 4 bezier control values, minimizing SSE of
/// `v0 + (v1-v0) * cubic_bezier(x1,y1,x2,y2,u)` against the segment's
/// interior `(u, value)` samples — the same predicted-value form every other
/// easing shape is scored against in `best_easing`, so a Bezier fit only
/// wins the competition when it's a genuinely better SHAPE, not an artifact
/// of scoring it differently.
fn fit_bezier(interior_uv: &[(f32, f32)], v0: f32, v1: f32) -> (f32, f32, f32, f32, f32) {
    let sse_for = |params: [f32; 4]| -> f32 {
        interior_uv
            .iter()
            .map(|&(u, v)| {
                let y = cubic_bezier(params[0], params[1], params[2], params[3], u);
                (v0 + (v1 - v0) * y - v).powi(2)
            })
            .sum()
    };

    let bounds = [(0.0f32, 1.0f32), (-0.5f32, 2.0f32), (0.0f32, 1.0f32), (-0.5f32, 2.0f32)];
    let mut params = [0.25f32, 0.1, 0.25, 1.0]; // ease-in-out-ish seed
    // Shrinking-window coordinate descent (a fixed-resolution grid every
    // round would permanently cap precision at the grid step) — each param
    // gets its own 10-step scan centered on its current best, and the search
    // window halves every round, so ~10 rounds reach sub-1e-3 precision.
    let mut radius: [f32; 4] = bounds.map(|(lo, hi)| (hi - lo) / 2.0);
    let mut best_sse = sse_for(params);
    for _round in 0..10 {
        for k in 0..4 {
            let (lo_b, hi_b) = bounds[k];
            let lo = (params[k] - radius[k]).max(lo_b);
            let hi = (params[k] + radius[k]).min(hi_b);
            let steps = 10;
            let mut best_v = params[k];
            let mut best_local = best_sse;
            for s in 0..=steps {
                let v = lo + (hi - lo) * s as f32 / steps as f32;
                let mut trial = params;
                trial[k] = v;
                let e = sse_for(trial);
                if e < best_local {
                    best_local = e;
                    best_v = v;
                }
            }
            params[k] = best_v;
            best_sse = best_local;
        }
        for r in radius.iter_mut() {
            *r *= 0.5;
        }
    }
    (params[0], params[1], params[2], params[3], best_sse)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn times(n: usize, step_ms: u32) -> Vec<u32> {
        (0..n as u32).map(|i| i * step_ms).collect()
    }

    #[test]
    fn a_straight_ramp_needs_only_two_keys() {
        let t = times(20, 100);
        let values: Vec<f32> = t.iter().map(|&ms| ms as f32 / 10.0).collect();
        let fitted = fit_channels(&t, &[Channel { name: "x", values: &values }], (0, 1900), &[], &FitParams::default());
        assert_eq!(fitted[0].len(), 2, "expected a straight ramp to fit with just two keys, got {:?}", fitted[0]);
        assert_eq!(fitted[0][0].easing, Easing::Linear);
    }

    #[test]
    fn a_bend_gets_a_third_key_near_the_bend() {
        // Flat for the first half, ramps for the second — one real bend at t=1000.
        let t = times(20, 100);
        let values: Vec<f32> = t.iter().map(|&ms| if ms < 1000 { 0.0 } else { (ms - 1000) as f32 / 10.0 }).collect();
        let fitted = fit_channels(&t, &[Channel { name: "x", values: &values }], (0, 1900), &[], &FitParams::default());
        assert!(fitted[0].len() >= 3, "expected a bend key, got {:?}", fitted[0]);
        let mid = &fitted[0][1];
        assert!(mid.time_ms.abs_diff(1000) <= 100, "expected the bend key near t=1000, got {}", mid.time_ms);
    }

    #[test]
    fn a_single_frame_jump_is_recovered_as_hold() {
        // Flat, then one big single-step jump, then flat again — a punch-in.
        let t = times(20, 100);
        let values: Vec<f32> = t.iter().map(|&ms| if ms < 1000 { 1.0 } else { 2.0 }).collect();
        let fitted = fit_channels(&t, &[Channel { name: "scale", values: &values }], (0, 1900), &[], &FitParams::default());
        let holds_before_jump = fitted[0].iter().any(|k| k.easing == Easing::Hold && k.time_ms < 1000);
        assert!(holds_before_jump, "expected a Hold key before the jump, got {:?}", fitted[0]);
    }

    #[test]
    fn an_overshoot_curve_is_recovered_as_bezier_not_eeaseinout() {
        let t = times(20, 100);
        let easing = |u: f32| cubic_bezier(0.34, 1.56, 0.64, 1.0, u);
        let values: Vec<f32> = t.iter().map(|&ms| { let u = ms as f32 / 1900.0; 100.0 * easing(u) }).collect();
        let fitted = fit_channels(&t, &[Channel { name: "scale", values: &values }], (0, 1900), &[], &FitParams::default());
        assert_eq!(fitted[0].len(), 2);
        assert!(matches!(fitted[0][0].easing, Easing::Bezier { .. }), "expected a Bezier easing, got {:?}", fitted[0][0].easing);
    }

    #[test]
    fn channels_share_key_times() {
        let t = times(20, 100);
        let scale: Vec<f32> = t.iter().map(|&ms| if ms < 1000 { 1.0 } else { 1.0 + (ms - 1000) as f32 / 900.0 }).collect();
        let rot: Vec<f32> = t.iter().map(|&ms| if ms < 1000 { 0.0 } else { (ms - 1000) as f32 / 30.0 }).collect();
        let fitted = fit_channels(
            &t,
            &[Channel { name: "scale", values: &scale }, Channel { name: "rot", values: &rot }],
            (0, 1900),
            &[],
            &FitParams::default(),
        );
        let times_a: Vec<u32> = fitted[0].iter().map(|k| k.time_ms).collect();
        let times_b: Vec<u32> = fitted[1].iter().map(|k| k.time_ms).collect();
        assert_eq!(times_a, times_b, "expected every channel to share the same key times");
    }

    #[test]
    fn preferred_times_are_offered_as_dp_candidates() {
        // Direct test of the candidate-generation step (not the whole DP,
        // which is free to skip a candidate the data doesn't support — see
        // `an_annotated_bend_strong_enough_to_matter_gets_keyed` below for
        // the end-to-end case): a flat channel has no curvature at all, so
        // the only reason t=700 shows up is that it's a preferred time.
        let t = times(20, 100);
        let values = vec![5.0f32; t.len()];
        let cands = candidate_times(&t, &[Channel { name: "x", values: &values }], (0, 1900), &[700], 16);
        assert_eq!(cands, vec![700]);
    }

    #[test]
    fn an_annotated_bend_strong_enough_to_matter_gets_keyed() {
        let t = times(20, 100);
        // Two clearly different ramps meeting at t=700 — a real bend, not a
        // minor perturbation a single curve could absorb.
        let values: Vec<f32> = t.iter().map(|&ms| if ms < 700 { ms as f32 } else { 700.0 + (ms - 700) as f32 * 5.0 }).collect();
        let fitted = fit_channels(&t, &[Channel { name: "x", values: &values }], (0, 1900), &[700], &FitParams::default());
        assert!(fitted[0].iter().any(|k| k.time_ms == 700), "expected the annotated bend to be keyed, got {:?}", fitted[0]);
    }
}
