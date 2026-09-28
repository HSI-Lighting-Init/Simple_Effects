//! Phase 2.6/2.7: per-shot colour grade (brightness/contrast/saturation/
//! vignette) and fade-in/out estimation from a handful of low-res sampled
//! frames. Same split as `shots.rs`: a pure stats function over plain RGB8
//! buffers (`analyze_look_from_rgb_frames`) plus a thin ffmpeg sampler
//! (`analyze_look`) that feeds it real frames.

use std::process::Stdio;

use serde::Serialize;
use ts_rs::TS;

use crate::{find_ffmpeg, quiet_command};

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ShotLook {
    /// Engine-param-ready multiplier, 1.0 = unchanged (matches this app's
    /// existing "brightness" effect semantics: <1 darker, >1 brighter).
    pub brightness: f32,
    /// 1.0 = unchanged.
    pub contrast: f32,
    /// 1.0 = unchanged, 0.0 = greyscale.
    pub saturate: f32,
    /// 0.0..1.0, 0 = no visible vignette.
    pub vignette_strength: f32,
    /// 0 = no detected fade-in.
    pub fade_in_ms: u32,
    /// 0 = no detected fade-out.
    pub fade_out_ms: u32,
}

#[inline]
fn luma(r: f32, g: f32, b: f32) -> f32 {
    0.299 * r + 0.587 * g + 0.114 * b
}

/// A single frame's mean luminance (used for the fade-edge walk, where each
/// frame collapses to one brightness number over time).
fn frame_mean_luma(buf: &[u8]) -> f32 {
    let n = buf.len() / 3;
    if n == 0 {
        return 0.0;
    }
    let sum: f64 = buf.chunks_exact(3).map(|p| luma(p[0] as f32, p[1] as f32, p[2] as f32) as f64).sum();
    (sum / n as f64) as f32
}

/// Re-expresses `frames` (already time-sorted) "from one edge inward": `dt`
/// is 0 at that edge frame and grows as we move toward the shot's middle —
/// so the same ramp-detection logic (`ramp_from`) works for both fade-in
/// (from the start) and fade-out (from the end, walked backwards).
fn edge_series(frames: &[(u32, f32)], from_end: bool) -> Vec<(u32, f32)> {
    if from_end {
        let last_t = frames.last().map(|f| f.0).unwrap_or(0);
        frames.iter().rev().map(|&(t, l)| (last_t - t, l)).collect()
    } else {
        let first_t = frames.first().map(|f| f.0).unwrap_or(0);
        frames.iter().map(|&(t, l)| (t - first_t, l)).collect()
    }
}

/// Does `series` (edge-ordered per `edge_series`) ramp from near `target`
/// (0.0 = black, 255.0 = white) up toward `mid_mean`, the shot's own
/// middle-window brightness? Requires (a) a real gap between `target` and
/// `mid_mean` — a shot that's simply dark throughout has nothing to ramp
/// across, so it wouldn't false-positive as "fading from black" — and (b)
/// the edge frame itself actually starts near `target`, not already near
/// `mid_mean`. Returns the ms (from the edge) at which luminance first
/// reaches 90% of the way from `target` to `mid_mean`.
fn ramp_from(series: &[(u32, f32)], target: f32, mid_mean: f32) -> Option<u32> {
    let gap = mid_mean - target;
    if gap.abs() < 30.0 || series.len() < 2 {
        return None;
    }
    let first = series[0].1;
    if (first - target).abs() >= gap.abs() * 0.5 {
        return None; // the edge frame isn't actually near this extreme
    }
    let threshold = target + 0.9 * gap;
    for &(dt, l) in series {
        let reached = if gap > 0.0 { l >= threshold } else { l <= threshold };
        if reached {
            return Some(dt);
        }
    }
    None // never got within 90% of the shot's own level within the sampled frames
}

/// Fade duration at one edge of the shot. Tries both a from-black and a
/// from-white ramp (a fade can go either way) and reports whichever is
/// actually detected; if — rare edge case — both look plausible, the
/// shorter (tighter) one.
/// ponytail: naive two-candidate heuristic on a handful of samples, no
/// monotonicity check or outlier rejection; revisit if real, noisy footage
/// starts false-positiving.
fn detect_edge_fade(frames: &[(u32, f32)], mid_mean: f32, from_end: bool) -> u32 {
    if frames.len() < 2 {
        return 0;
    }
    let series = edge_series(frames, from_end);
    let black = ramp_from(&series, 0.0, mid_mean);
    let white = ramp_from(&series, 255.0, mid_mean);
    match (black, white) {
        (Some(b), Some(w)) => b.min(w),
        (Some(b), None) => b,
        (None, Some(w)) => w,
        (None, None) => 0,
    }
}

/// Reference points for the "unchanged" (1.0) multiplier on each stat —
/// documented judgement calls, not measured constants:
/// - brightness: a mean luminance of 128 (mid-grey) reads as a normally
///   exposed frame.
/// - contrast: ~60 std-dev of luminance is a typical spread for an ordinary
///   photo (shadow to highlight); flatter/punchier grades scale from there.
/// - saturate: ~40 mean per-pixel chroma (max(r,g,b)-min(r,g,b)) is a
///   moderately colourful scene; 0 is pure greyscale.
const REF_LUMA: f32 = 128.0;
const REF_CONTRAST_STD: f32 = 60.0;
const REF_CHROMA: f32 = 40.0;
/// Outer-margin fraction (per side) treated as "border" for the vignette
/// check; the rest is "centre".
const VIGNETTE_MARGIN_FRAC: f32 = 0.15;

/// Estimate one shot's colour grade and fades from a handful of sampled RGB8
/// frames: `(t_ms relative to the shot's start, RGB8 pixels — width*height*3
/// bytes each)`. Frame order doesn't matter, they're sorted by time here.
pub fn analyze_look_from_rgb_frames(frames: &[(u32, Vec<u8>)], width: u32, height: u32) -> ShotLook {
    let identity = ShotLook { brightness: 1.0, contrast: 1.0, saturate: 1.0, vignette_strength: 0.0, fade_in_ms: 0, fade_out_ms: 0 };
    if frames.is_empty() || width == 0 || height == 0 {
        return identity;
    }
    let mut sorted: Vec<&(u32, Vec<u8>)> = frames.iter().collect();
    sorted.sort_by_key(|f| f.0);

    // Middle ~50% of frames by index — frames are evenly spaced in time, so
    // this is also roughly the middle 50% by time.
    let n = sorted.len();
    let mid_lo = n / 4;
    let mid_hi = (n - n / 4).max(mid_lo + 1).min(n);
    let middle = &sorted[mid_lo..mid_hi];

    let margin_x = ((width as f32) * VIGNETTE_MARGIN_FRAC).round() as u32;
    let margin_y = ((height as f32) * VIGNETTE_MARGIN_FRAC).round() as u32;

    let mut luma_sum = 0f64;
    let mut luma_sq_sum = 0f64;
    let mut chroma_sum = 0f64;
    let mut px_count = 0u64;
    let mut border_sum = 0f64;
    let mut border_count = 0u64;
    let mut center_sum = 0f64;
    let mut center_count = 0u64;
    for &(_, buf) in middle {
        if buf.len() as u64 != width as u64 * height as u64 * 3 {
            continue; // malformed frame — skip rather than index out of bounds
        }
        for y in 0..height {
            for x in 0..width {
                let o = ((y * width + x) * 3) as usize;
                let (r, g, b) = (buf[o] as f32, buf[o + 1] as f32, buf[o + 2] as f32);
                let l = luma(r, g, b) as f64;
                luma_sum += l;
                luma_sq_sum += l * l;
                chroma_sum += (r.max(g).max(b) - r.min(g).min(b)) as f64;
                px_count += 1;
                let border = x < margin_x || x >= width - margin_x || y < margin_y || y >= height - margin_y;
                if border {
                    border_sum += l;
                    border_count += 1;
                } else {
                    center_sum += l;
                    center_count += 1;
                }
            }
        }
    }
    if px_count == 0 {
        return identity;
    }

    let mean_luma = luma_sum / px_count as f64;
    let variance = (luma_sq_sum / px_count as f64 - mean_luma * mean_luma).max(0.0);
    let std_luma = variance.sqrt();
    let mean_chroma = chroma_sum / px_count as f64;
    let border_mean = if border_count > 0 { border_sum / border_count as f64 } else { mean_luma };
    let center_mean = if center_count > 0 { center_sum / center_count as f64 } else { mean_luma };

    let brightness = ((mean_luma as f32) / REF_LUMA).clamp(0.3, 3.0);
    let contrast = ((std_luma as f32) / REF_CONTRAST_STD).clamp(0.0, 4.0);
    let saturate = ((mean_chroma as f32) / REF_CHROMA).clamp(0.0, 4.0);
    let vignette_strength = (((center_mean - border_mean) / center_mean.max(1.0)) as f32).clamp(0.0, 1.0);

    let series: Vec<(u32, f32)> = sorted.iter().map(|(t, buf)| (*t, frame_mean_luma(buf))).collect();
    let fade_in_ms = detect_edge_fade(&series, mean_luma as f32, false);
    let fade_out_ms = detect_edge_fade(&series, mean_luma as f32, true);

    ShotLook { brightness, contrast, saturate, vignette_strength, fade_in_ms, fade_out_ms }
}

/// Decode ~9 evenly-spaced small (64x64 — this only needs aggregate colour
/// stats, not geometry) RGB frames across `[start_ms, end_ms]`, one `ffmpeg
/// -ss <t> -i path -frames:v 1` seek per timestamp (the same per-timestamp
/// fast-seek shape as `analyze/mod.rs`'s `extract_frames`, kept
/// self-contained here rather than imported), and feed them to
/// `analyze_look_from_rgb_frames`.
pub(crate) fn analyze_look(path: &str, start_ms: u32, end_ms: u32) -> Result<ShotLook, String> {
    let ffmpeg = find_ffmpeg().ok_or("ffmpeg not found — install it to analyze shot look")?;
    const SAMPLES: u32 = 9;
    const SIZE: u32 = 64;
    let span = end_ms.saturating_sub(start_ms);
    let scale = format!("scale={SIZE}:{SIZE}");
    let mut frames = Vec::with_capacity(SAMPLES as usize);
    for i in 0..SAMPLES {
        let t = start_ms + span * i / (SAMPLES - 1);
        let ts = format!("{:.3}", t as f64 / 1000.0);
        let output = quiet_command(&ffmpeg)
            .args(["-ss", &ts, "-i", path, "-frames:v", "1", "-vf", &scale, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .map_err(|e| format!("ffmpeg: {e}"))?;
        let expected = (SIZE * SIZE * 3) as usize;
        if output.status.success() && output.stdout.len() == expected {
            frames.push((t - start_ms, output.stdout));
        }
    }
    if frames.is_empty() {
        return Err("no frames decoded for look analysis".into());
    }
    Ok(analyze_look_from_rgb_frames(&frames, SIZE, SIZE))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid_frame(width: u32, height: u32, v: [u8; 3]) -> Vec<u8> {
        let mut buf = Vec::with_capacity((width * height * 3) as usize);
        for _ in 0..(width * height) {
            buf.extend_from_slice(&v);
        }
        buf
    }

    /// A 2-colour checkerboard, NOT a literally flat frame. A truly flat
    /// single-colour frame has zero spatial variance by construction, which
    /// would make contrast/saturate trivially 0 regardless of the mapping —
    /// not a meaningful test of the "normal, unchanged" case. `a`/`b` are
    /// symmetric about mid-grey (128±d per channel) so the pooled mean is
    /// exactly mid-grey regardless of their spread.
    fn checkerboard_frame(width: u32, height: u32, a: [u8; 3], b: [u8; 3]) -> Vec<u8> {
        let mut buf = vec![0u8; (width * height * 3) as usize];
        for y in 0..height {
            for x in 0..width {
                let c = if (x + y) % 2 == 0 { a } else { b };
                let o = ((y * width + x) * 3) as usize;
                buf[o] = c[0];
                buf[o + 1] = c[1];
                buf[o + 2] = c[2];
            }
        }
        buf
    }

    #[test]
    fn textured_mid_grey_reads_as_unchanged() {
        // Chosen so pooled luminance std ≈ 60 (REF_CONTRAST_STD) and mean
        // chroma ≈ 40 (REF_CHROMA), while both colours average to exact
        // mid-grey (128,128,128) — see `checkerboard_frame`'s doc.
        let (w, h) = (16, 16);
        let a = [165u8, 204, 165];
        let b = [91u8, 52, 91];
        let frames: Vec<(u32, Vec<u8>)> = (0..8).map(|i| (i * 100, checkerboard_frame(w, h, a, b))).collect();
        let look = analyze_look_from_rgb_frames(&frames, w, h);
        assert!((look.brightness - 1.0).abs() < 0.1, "brightness={}", look.brightness);
        assert!((look.contrast - 1.0).abs() < 0.25, "contrast={}", look.contrast);
        assert!((look.saturate - 1.0).abs() < 0.25, "saturate={}", look.saturate);
        assert!(look.vignette_strength < 0.1, "vignette={}", look.vignette_strength);
        assert_eq!(look.fade_in_ms, 0);
        assert_eq!(look.fade_out_ms, 0);
    }

    #[test]
    fn bright_shot_reads_brighter_than_unchanged() {
        let frames: Vec<(u32, Vec<u8>)> = (0..6).map(|i| (i * 100, solid_frame(16, 16, [220, 220, 220]))).collect();
        let look = analyze_look_from_rgb_frames(&frames, 16, 16);
        assert!(look.brightness > 1.2, "brightness={}", look.brightness);
    }

    #[test]
    fn dark_shot_reads_darker_than_unchanged() {
        let frames: Vec<(u32, Vec<u8>)> = (0..6).map(|i| (i * 100, solid_frame(16, 16, [40, 40, 40]))).collect();
        let look = analyze_look_from_rgb_frames(&frames, 16, 16);
        assert!(look.brightness < 0.7, "brightness={}", look.brightness);
    }

    #[test]
    fn fade_in_from_black_is_detected_fade_out_is_not() {
        let (w, h) = (16, 16);
        // Ramps over the first 5 of 20 frames (~20%), then holds steady.
        let ramp = [0u8, 40, 90, 130, 150];
        let mut frames: Vec<(u32, Vec<u8>)> = Vec::new();
        let mut t = 0u32;
        for &v in ramp.iter() {
            frames.push((t, solid_frame(w, h, [v, v, v])));
            t += 100;
        }
        for _ in 0..15 {
            frames.push((t, solid_frame(w, h, [150, 150, 150])));
            t += 100;
        }
        let look = analyze_look_from_rgb_frames(&frames, w, h);
        assert!(look.fade_in_ms >= 300 && look.fade_in_ms <= 500, "fade_in_ms={}", look.fade_in_ms);
        assert_eq!(look.fade_out_ms, 0, "steady end shouldn't register a fade");
    }

    #[test]
    fn vignette_is_detected_from_border_vs_centre() {
        let (w, h) = (20, 20);
        let margin = 3u32; // matches round(20 * 0.15)
        let mut buf = vec![0u8; (w * h * 3) as usize];
        for y in 0..h {
            for x in 0..w {
                let border = x < margin || x >= w - margin || y < margin || y >= h - margin;
                let v = if border { 40u8 } else { 200u8 };
                let o = ((y * w + x) * 3) as usize;
                buf[o] = v;
                buf[o + 1] = v;
                buf[o + 2] = v;
            }
        }
        let frames: Vec<(u32, Vec<u8>)> = (0..6).map(|i| (i * 100, buf.clone())).collect();
        let look = analyze_look_from_rgb_frames(&frames, w, h);
        assert!(look.vignette_strength > 0.3, "vignette={}", look.vignette_strength);
        assert!(look.brightness > 0.1 && look.brightness < 3.0, "brightness={}", look.brightness);
        assert_eq!(look.fade_in_ms, 0);
        assert_eq!(look.fade_out_ms, 0);
    }

    #[test]
    fn saturated_colour_reads_higher_than_desaturated_grey() {
        let (w, h) = (16, 16);
        let saturated: Vec<(u32, Vec<u8>)> = (0..6).map(|i| (i * 100, solid_frame(w, h, [200, 50, 50]))).collect();
        let grey: Vec<(u32, Vec<u8>)> = (0..6).map(|i| (i * 100, solid_frame(w, h, [128, 128, 128]))).collect();
        let sat_look = analyze_look_from_rgb_frames(&saturated, w, h);
        let grey_look = analyze_look_from_rgb_frames(&grey, w, h);
        assert!(sat_look.saturate > grey_look.saturate + 0.5, "sat={} grey={}", sat_look.saturate, grey_look.saturate);
    }
}
