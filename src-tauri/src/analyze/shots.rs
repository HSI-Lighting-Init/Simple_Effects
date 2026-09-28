//! Phase 2.2: shot/cut segmentation. A pure per-frame sampler over a
//! streamed low-res decode, then a pure classifier (`segment_cuts`) that
//! turns the sample curve into cuts, combining two passes:
//! - an **adaptive** content-diff detector (PySceneDetect's AdaptiveDetector
//!   idea): a frame's diff must be a multiple of its own neighbourhood's
//!   rolling average, not just above a fixed number — catches low-contrast
//!   cuts a fixed threshold misses, without misfiring on shots whose own
//!   motion baseline is naturally high;
//! - a **brightness** pass for fades and dips to black, which a diff-based
//!   detector can miss entirely (a slow linear fade keeps frame-to-frame
//!   diff roughly constant, never spiking above its own baseline).
//! Calibrated empirically against a synthetic reference with known cut times
//! (see the `#[ignore]`d recheck-style test at the bottom) and the real
//! Envato reference's missed cut (see `docs/STATUS-inverse-render-pipeline.md`),
//! not guessed.

use std::io::Read;
use std::process::Stdio;

use serde::Serialize;
use ts_rs::TS;

use crate::{find_ffmpeg, quiet_command};

/// One decoded frame: its own mean luminance, and its diff against the
/// previous frame — both normalized 0..1.
#[derive(Clone, Copy, Debug)]
pub(crate) struct FrameSample {
    t_ms: u32,
    diff: f32,
    mean_luma: f32,
}

fn frame_samples(path: &str, fps: f32, short_side: u32) -> Result<Vec<FrameSample>, String> {
    let ffmpeg = find_ffmpeg().ok_or("ffmpeg not found — install it to use shot detection")?;
    let vf = format!("fps={fps},scale={short_side}:-2");
    let mut child = quiet_command(&ffmpeg)
        .args(["-i", path, "-vf", &vf, "-f", "rawvideo", "-pix_fmt", "gray", "-"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("ffmpeg: {e}"))?;
    let mut stdout = child.stdout.take().ok_or("no ffmpeg stdout")?;
    let mut buf = Vec::new();
    stdout.read_to_end(&mut buf).map_err(|e| format!("read ffmpeg output: {e}"))?;
    let _ = child.wait();

    // Width isn't known up front (scale=W:-2 rounds height to even) — probe
    // it via ffprobe once rather than parsing ffmpeg's stderr.
    let probe = quiet_command(&ffmpeg)
        .args(["-i", path, "-vf", &vf, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("ffmpeg probe: {e}"))?;
    let frame_pixels = probe.stdout.len();
    if frame_pixels == 0 {
        return Err("couldn't determine frame size".into());
    }

    let frame_ms = 1000.0 / fps;
    let mut out = Vec::with_capacity(buf.len() / frame_pixels);
    let mut prev: Option<&[u8]> = None;
    for (i, frame) in buf.chunks_exact(frame_pixels).enumerate() {
        let t_ms = (i as f32 * frame_ms).round() as u32;
        let mean_luma = (frame.iter().map(|&b| b as u64).sum::<u64>() as f64 / frame_pixels as f64 / 255.0) as f32;
        let diff = match prev {
            None => 0.0,
            Some(p) => {
                let sum: u64 = p.iter().zip(frame.iter()).map(|(a, b)| (*a as i32 - *b as i32).unsigned_abs() as u64).sum();
                (sum as f64 / frame_pixels as f64 / 255.0) as f32
            }
        };
        out.push(FrameSample { t_ms, diff, mean_luma });
        prev = Some(frame);
    }
    Ok(out)
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum CutKind {
    Hard,
    Soft,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct Cut {
    pub t_ms: u32,
    pub kind: CutKind,
    /// For a soft cut, roughly how long the elevated-difference window was.
    pub span_ms: u32,
}

/// Calibration knobs (see the module doc) — tuned against a synthetic
/// reference with known cut times, not guessed.
/// ponytail: one pass of empirical tuning; revisit against more references
/// (especially real, re-encoded reels) if it starts missing real cuts or
/// flagging mid-shot motion.
pub struct CutParams {
    /// A frame's diff must be at least this many times its neighbourhood's
    /// rolling average to count as a cut (PySceneDetect's AdaptiveDetector
    /// idea) — robust to shots whose own motion baseline is high or low,
    /// and catches low-contrast cuts whose absolute diff is small but still
    /// far above their own quiet baseline.
    pub adaptive_ratio: f32,
    /// How many frames on each side make up the rolling-average neighbourhood.
    pub adaptive_window: usize,
    /// Floor under both the peak diff and the neighbourhood average, so
    /// near-silent noise never produces a spurious ratio.
    pub min_content: f32,
    /// Only sizes a peak's neighbourhood for the hard/soft width
    /// classification — not a detection threshold.
    pub soft: f32,
    pub min_gap_ms: u32,
    /// A frame counts as "black" below this mean luminance (0..1) — flags
    /// the boundaries of a fade/dip to black.
    pub black_luma: f32,
}

impl Default for CutParams {
    fn default() -> Self {
        // adaptive_ratio/window/min_content: calibrated against the real
        // Envato reference's missed cut at ~20.25s (STATUS-inverse-render-
        // pipeline.md) — that cut's peak diff (0.071, under the old fixed
        // hard=0.08) sits in a neighbourhood averaging ~0.01, a ~7x ratio,
        // comfortably clear of both the 3.0 ratio and the noise floor.
        // black_luma: near-black, not pure black — real footage rarely hits
        // exactly 0.
        CutParams { adaptive_ratio: 3.0, adaptive_window: 2, min_content: 0.015, soft: 0.03, min_gap_ms: 400, black_luma: 0.06 }
    }
}

/// Pure classifier: turn a per-frame sample curve into cuts. Combines the
/// adaptive content-diff pass and the brightness pass (module doc), then
/// merges peaks within `min_gap_ms` of each other, keeping the stronger
/// (wider-span) one — the two passes can both fire near the same boundary.
pub fn segment_cuts(samples: &[FrameSample], p: &CutParams) -> Vec<Cut> {
    let mut cuts = adaptive_cuts(samples, p);
    cuts.extend(fade_cuts(samples, p));
    cuts.sort_by_key(|c| c.t_ms);
    let mut merged: Vec<Cut> = Vec::new();
    for c in cuts {
        if let Some(last) = merged.last_mut() {
            if c.t_ms.abs_diff(last.t_ms) < p.min_gap_ms {
                if c.span_ms > last.span_ms {
                    *last = c;
                }
                continue;
            }
        }
        merged.push(c);
    }
    merged
}

/// Finds every LOCAL MAXIMUM whose diff is at least `adaptive_ratio` times
/// its own neighbourhood's rolling average (not just the strongest one in a
/// region) — two real cuts close enough together that the signal never
/// fully settles between them (a rapid flash-cut pair) still show up as two
/// distinct peaks, which a single-threshold "region" scan would merge into
/// one and silently drop a shot.
fn adaptive_cuts(samples: &[FrameSample], p: &CutParams) -> Vec<Cut> {
    let n = samples.len();
    let mut cuts = Vec::new();
    for i in 0..n {
        let s = samples[i].diff;
        if s < p.min_content {
            continue;
        }
        let lo = i.saturating_sub(p.adaptive_window);
        let hi = (i + p.adaptive_window + 1).min(n);
        let mut sum = 0.0f32;
        let mut cnt = 0u32;
        for (j, sample) in samples.iter().enumerate().take(hi).skip(lo) {
            if j == i {
                continue;
            }
            sum += sample.diff;
            cnt += 1;
        }
        if cnt == 0 {
            continue;
        }
        let avg = (sum / cnt as f32).max(p.min_content);
        if s / avg < p.adaptive_ratio {
            continue;
        }
        let left = if i > 0 { samples[i - 1].diff } else { f32::MIN };
        let right = if i + 1 < n { samples[i + 1].diff } else { f32::MIN };
        if s < left || s < right {
            continue; // not a local maximum
        }

        let mut w_lo = i;
        while w_lo > 0 && samples[w_lo - 1].diff >= p.soft {
            w_lo -= 1;
        }
        let mut w_hi = i;
        while w_hi + 1 < n && samples[w_hi + 1].diff >= p.soft {
            w_hi += 1;
        }
        let span_ms = samples[w_hi].t_ms - samples[w_lo].t_ms;
        let kind = if w_hi - w_lo >= 2 { CutKind::Soft } else { CutKind::Hard };
        cuts.push(Cut { t_ms: samples[i].t_ms, kind, span_ms });
    }
    cuts
}

/// A frame-diff detector structurally can't see a slow linear fade — each
/// step looks like every other step, never spiking above its own baseline —
/// so this watches mean luminance directly and flags every crossing of
/// `black_luma`, in either direction (fade-to-black and fade-from-black).
fn fade_cuts(samples: &[FrameSample], p: &CutParams) -> Vec<Cut> {
    let mut cuts = Vec::new();
    for i in 1..samples.len() {
        let was_black = samples[i - 1].mean_luma < p.black_luma;
        let is_black = samples[i].mean_luma < p.black_luma;
        if was_black != is_black {
            cuts.push(Cut { t_ms: samples[i].t_ms, kind: CutKind::Soft, span_ms: 0 });
        }
    }
    cuts
}

pub(crate) fn detect_cuts(path: &str, fps: f32, short_side: u32, params: &CutParams) -> Result<Vec<Cut>, String> {
    let samples = frame_samples(path, fps, short_side)?;
    Ok(segment_cuts(&samples, params))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds samples with a flat, non-black luminance (0.5) so tests that
    /// only care about the diff curve don't also trip the fade pass.
    fn samples_from_diffs(diffs: &[(u32, f32)]) -> Vec<FrameSample> {
        diffs.iter().map(|&(t_ms, diff)| FrameSample { t_ms, diff, mean_luma: 0.5 }).collect()
    }

    #[test]
    fn flat_quiet_signal_has_no_cuts() {
        let diffs: Vec<(u32, f32)> = (0..40).map(|i| (i * 100, 0.002)).collect();
        let cuts = segment_cuts(&samples_from_diffs(&diffs), &CutParams::default());
        assert!(cuts.is_empty());
    }

    #[test]
    fn a_single_spike_is_a_hard_cut() {
        let mut diffs: Vec<(u32, f32)> = (0..40).map(|i| (i * 100, 0.002)).collect();
        diffs[20].1 = 0.2;
        let cuts = segment_cuts(&samples_from_diffs(&diffs), &CutParams::default());
        assert_eq!(cuts.len(), 1);
        assert_eq!(cuts[0].kind, CutKind::Hard);
        assert_eq!(cuts[0].t_ms, 2000);
    }

    #[test]
    fn a_sustained_ramp_is_a_soft_cut_not_several_hard_ones() {
        let mut diffs: Vec<(u32, f32)> = (0..40).map(|i| (i * 100, 0.002)).collect();
        for (k, v) in [(18, 0.04), (19, 0.06), (20, 0.15), (21, 0.05)] {
            diffs[k].1 = v;
        }
        let cuts = segment_cuts(&samples_from_diffs(&diffs), &CutParams::default());
        assert_eq!(cuts.len(), 1, "expected one soft cut, got {:?}", cuts);
        assert_eq!(cuts[0].kind, CutKind::Soft);
    }

    #[test]
    fn nearby_cuts_merge() {
        let mut diffs: Vec<(u32, f32)> = (0..40).map(|i| (i * 100, 0.002)).collect();
        diffs[20].1 = 0.2;
        diffs[21].1 = 0.18; // 100ms later, under min_gap_ms — same cut
        let cuts = segment_cuts(&samples_from_diffs(&diffs), &CutParams::default());
        assert_eq!(cuts.len(), 1, "expected the two nearby spikes to merge, got {:?}", cuts);
    }

    #[test]
    fn a_low_contrast_cut_the_old_fixed_threshold_missed_is_now_caught() {
        // Mirrors the real Envato reference's missed cut: a quiet, mostly-
        // static shot (baseline diff ~0.01) cutting into another quiet shot,
        // peak diff 0.05 — well under the old fixed hard=0.08 threshold, but
        // ~5x the local baseline.
        let mut diffs: Vec<(u32, f32)> = (0..40).map(|i| (i * 100, 0.01)).collect();
        diffs[20].1 = 0.05;
        let cuts = segment_cuts(&samples_from_diffs(&diffs), &CutParams::default());
        assert_eq!(cuts.len(), 1, "expected the low-contrast cut to be caught, got {:?}", cuts);
        assert_eq!(cuts[0].t_ms, 2000);
    }

    #[test]
    fn a_naturally_busy_baseline_does_not_misfire() {
        // A shot with real, sustained motion (e.g. handheld footage) has a
        // high but roughly steady diff throughout — the adaptive ratio
        // should stay near 1 and never cross adaptive_ratio, unlike a fixed
        // threshold which could be tripped by the baseline alone.
        let diffs: Vec<(u32, f32)> = (0..40).map(|i| (i * 100, 0.06 + 0.01 * ((i % 3) as f32 - 1.0))).collect();
        let cuts = segment_cuts(&samples_from_diffs(&diffs), &CutParams::default());
        assert!(cuts.is_empty(), "expected no cuts on a steady busy baseline, got {:?}", cuts);
    }

    #[test]
    fn a_slow_fade_to_black_is_caught_by_the_brightness_pass() {
        // A linear fade keeps frame-to-frame diff roughly constant and low
        // (never spikes above its own baseline) — undetectable by the diff
        // pass alone. Luminance ramps from bright (0.5) to black (0.0) over
        // 10 frames, then holds black.
        let mut samples = Vec::new();
        for i in 0..40u32 {
            let t_ms = i * 100;
            if i < 20 {
                samples.push(FrameSample { t_ms, diff: 0.002, mean_luma: 0.5 });
            } else if i < 30 {
                let frac = (i - 20) as f32 / 10.0;
                samples.push(FrameSample { t_ms, diff: 0.005, mean_luma: 0.5 * (1.0 - frac) });
            } else {
                samples.push(FrameSample { t_ms, diff: 0.0, mean_luma: 0.0 });
            }
        }
        let cuts = segment_cuts(&samples, &CutParams::default());
        assert_eq!(cuts.len(), 1, "expected one cut at the black crossing, got {:?}", cuts);
        assert_eq!(cuts[0].kind, CutKind::Soft);
    }

    /// Roadmap v3.2-style empirical check: run against the same synthetic
    /// reference used for the aligner, whose true cuts are known from its
    /// own generation (Phase 1.2's `make_synthetic_reference`). Not a normal
    /// regression test (depends on a file outside the repo) — run once with
    /// `cargo test --lib analyze::shots::tests::recheck_against_synthetic_1 -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn recheck_against_synthetic_1() {
        let path = "C:/Users/hsili/Desktop/SE-test-assets/synthetic/synthetic-1.mp4";
        let cuts = detect_cuts(path, 8.0, 128, &CutParams::default()).expect("detect_cuts");
        for c in &cuts {
            println!("{}ms {:?} span={}ms", c.t_ms, c.kind, c.span_ms);
        }
        // True boundaries (from synthetic-1.truth.json): 2732(hard),
        // 3341(hard), 5734(soft ~pageTurn), 9670(hard), 13562(soft ~checkerboard).
    }

    /// The actual case this stage was built for: the real Envato reference's
    /// missed cut at ~20.25s into a near-black outro card (STATUS-inverse-
    /// render-pipeline.md). Not a normal regression test (depends on a file
    /// outside the repo) — run once with `cargo test --lib
    /// analyze::shots::tests::recheck_envato_outro_cut -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn recheck_envato_outro_cut() {
        let path = "C:/Users/hsili/Desktop/preview_540p_crf22_higher_quality.mp4";
        let cuts = detect_cuts(path, 8.0, 128, &CutParams::default()).expect("detect_cuts");
        for c in &cuts {
            println!("{}ms {:?} span={}ms", c.t_ms, c.kind, c.span_ms);
        }
        // The STATUS doc's 20250ms came from a raw diff-peak dump; the fix
        // that actually catches it is the brightness pass, which fires at
        // the luminance crossing a few frames later (125ms/frame at 8fps),
        // not the diff peak itself — 500ms (4 frames) covers that gap.
        assert!(
            cuts.iter().any(|c| c.t_ms.abs_diff(20250) < 500),
            "expected a cut near 20250ms (the ENVATO outro), got {:?}",
            cuts
        );
    }
}
