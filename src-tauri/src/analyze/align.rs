//! Gate A / Phase 2.4: pyramidal inverse-compositional Lucas–Kanade similarity-
//! transform alignment (Baker & Matthews 2004). Given a reference ("widest")
//! frame and another frame from the same shot, both grayscale, recovers the
//! similarity transform (scale, rotation, translation) that warps the
//! reference into the target — this *is* the layer's Ken Burns transform
//! track, up to anchor/centre bookkeeping (see `align_shot` in `mod.rs`'s
//! Gate A harness). Huber-weighted (IRLS) so a patch of moving text or a
//! compression artifact doesn't drag the whole estimate off; each frame is
//! initialized from the previous frame's result by the caller, not identity.
//!
//! `// ponytail: hand-rolled LK; the roadmap's fallback if Gate A says no-go
//! is a Python/OpenCV (ECC) tracker behind the same tool interface.`

use image::GrayImage;

/// A 2D similarity transform `warp(x) = M*x + t`, `M = [[re,-im],[im,re]]`,
/// applied to coordinates measured from the image CENTRE (not the pixel-grid
/// origin) — matching how this engine's own `transform.scale/rotation` pivot
/// around the layer's anchor. `(re, im)` is `M` as a "complex number": scale
/// = hypot(re,im), rotation = atan2(im,re). Composing two similarity
/// transforms is complex multiplication, so this representation keeps warp
/// composition/inversion cheap and exact (no 2x2 matrix inverse needed).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SimParams {
    pub re: f32,
    pub im: f32,
    pub tx: f32,
    pub ty: f32,
}

impl SimParams {
    pub const IDENTITY: SimParams = SimParams { re: 1.0, im: 0.0, tx: 0.0, ty: 0.0 };

    pub fn scale(&self) -> f32 {
        (self.re * self.re + self.im * self.im).sqrt()
    }
    pub fn rotation_rad(&self) -> f32 {
        self.im.atan2(self.re)
    }

    fn apply(&self, x: f32, y: f32) -> (f32, f32) {
        (self.re * x - self.im * y + self.tx, self.im * x + self.re * y + self.ty)
    }

    /// self ∘ other: apply `other` first, then `self`.
    fn compose(&self, other: &SimParams) -> SimParams {
        let re = self.re * other.re - self.im * other.im;
        let im = self.re * other.im + self.im * other.re;
        let (tx, ty) = self.apply(other.tx, other.ty);
        SimParams { re, im, tx, ty }
    }

    fn inverse(&self) -> SimParams {
        let d = (self.re * self.re + self.im * self.im).max(1e-12);
        let re = self.re / d;
        let im = -self.im / d;
        let tx = -(re * self.tx - im * self.ty);
        let ty = -(im * self.tx + re * self.ty);
        SimParams { re, im, tx, ty }
    }
}

struct GrayBuf {
    w: usize,
    h: usize,
    px: Vec<f32>, // luminance 0..255
}

impl GrayBuf {
    fn from_image(img: &GrayImage) -> Self {
        let (w, h) = img.dimensions();
        GrayBuf { w: w as usize, h: h as usize, px: img.pixels().map(|p| p[0] as f32).collect() }
    }

    fn get(&self, x: i32, y: i32) -> Option<f32> {
        if x < 0 || y < 0 || x as usize >= self.w || y as usize >= self.h {
            return None;
        }
        Some(self.px[y as usize * self.w + x as usize])
    }

    /// Bilinear sample at CENTRE-relative coordinates. None outside the
    /// valid (interior) sampling area — those pixels drop out of the LK sum
    /// rather than contaminating it with a wrapped/extrapolated value.
    fn sample_centered(&self, x: f32, y: f32) -> Option<f32> {
        let px = x + self.w as f32 / 2.0;
        let py = y + self.h as f32 / 2.0;
        if px < 0.0 || py < 0.0 || px >= (self.w as f32 - 1.0) || py >= (self.h as f32 - 1.0) {
            return None;
        }
        let x0f = px.floor();
        let y0f = py.floor();
        let (fx, fy) = (px - x0f, py - y0f);
        let (x0, y0) = (x0f as i32, y0f as i32);
        let a = self.get(x0, y0)?;
        let b = self.get(x0 + 1, y0)?;
        let c = self.get(x0, y0 + 1)?;
        let d = self.get(x0 + 1, y0 + 1)?;
        Some(a * (1.0 - fx) * (1.0 - fy) + b * fx * (1.0 - fy) + c * (1.0 - fx) * fy + d * fx * fy)
    }

    /// Central-difference gradient at a RAW pixel-grid integer coordinate
    /// (same convention as `get` — the caller centres separately for the SD
    /// vector, so this must not re-offset).
    fn gradient(&self, px: i32, py: i32) -> Option<(f32, f32)> {
        let l = self.get(px - 1, py)?;
        let r = self.get(px + 1, py)?;
        let u = self.get(px, py - 1)?;
        let d = self.get(px, py + 1)?;
        Some(((r - l) / 2.0, (d - u) / 2.0))
    }
}

fn downsample(g: &GrayBuf) -> GrayBuf {
    let nw = (g.w / 2).max(1);
    let nh = (g.h / 2).max(1);
    let mut px = vec![0f32; nw * nh];
    for y in 0..nh {
        for x in 0..nw {
            let x0 = (x * 2).min(g.w - 1);
            let x1 = (x * 2 + 1).min(g.w - 1);
            let y0 = (y * 2).min(g.h - 1);
            let y1 = (y * 2 + 1).min(g.h - 1);
            let s = g.px[y0 * g.w + x0] + g.px[y0 * g.w + x1] + g.px[y1 * g.w + x0] + g.px[y1 * g.w + x1];
            px[y * nw + x] = s / 4.0;
        }
    }
    GrayBuf { w: nw, h: nh, px }
}

fn build_pyramid(base: GrayBuf, levels: usize) -> Vec<GrayBuf> {
    let mut out = Vec::with_capacity(levels);
    out.push(base);
    for _ in 1..levels {
        let next = downsample(out.last().unwrap());
        out.push(next);
    }
    out // [0] = full res (finest), [last] = coarsest
}

/// Gauss-Jordan elimination with partial pivoting for a small dense system.
fn solve4(a: &[[f32; 4]; 4], b: &[f32; 4]) -> Option<[f32; 4]> {
    let mut m = *a;
    let mut v = *b;
    for col in 0..4 {
        let mut piv = col;
        for r in (col + 1)..4 {
            if m[r][col].abs() > m[piv][col].abs() {
                piv = r;
            }
        }
        if m[piv][col].abs() < 1e-8 {
            return None; // near-singular — degenerate/flat patch, no reliable solve
        }
        m.swap(col, piv);
        v.swap(col, piv);
        let d = m[col][col];
        for j in 0..4 {
            m[col][j] /= d;
        }
        v[col] /= d;
        for r in 0..4 {
            if r == col {
                continue;
            }
            let f = m[r][col];
            if f == 0.0 {
                continue;
            }
            for j in 0..4 {
                m[r][j] -= f * m[col][j];
            }
            v[r] -= f * v[col];
        }
    }
    Some(v)
}

fn huber_weight(residual: f32, thresh: f32) -> f32 {
    let ar = residual.abs();
    if ar <= thresh {
        1.0
    } else {
        thresh / ar
    }
}

const MAX_ITERS: usize = 40;
const CONVERGE_EPS: f32 = 1e-4;
/// Huber threshold as a multiple of the iteration's median-absolute residual
/// — adapts to each image pair's own contrast/noise level rather than a
/// fixed grayscale-unit constant.
const HUBER_MAD_MULT: f32 = 6.0;
const MIN_VALID_PIXELS: usize = 16;

/// One pyramid level of inverse-compositional LK. `template` and `image` must
/// be the same size. `init` seeds the search. `None` if there's too little
/// texture/overlap to solve (a near-singular Hessian, or too few in-bounds
/// samples — both signal "don't trust this", not "assume identity").
fn align_level(template: &GrayBuf, image: &GrayBuf, init: SimParams) -> Option<SimParams> {
    let cx = template.w as i32 / 2;
    let cy = template.h as i32 / 2;

    // Precomputed once per level: template gradient and the steepest-descent
    // vector per pixel. This is IC-LK's whole point — these never change
    // across iterations, only the residual-based re-weighting does.
    struct Pt {
        x: f32,
        y: f32,
        t: f32,
        sd: [f32; 4],
    }
    let mut pts: Vec<Pt> = Vec::with_capacity(template.w * template.h);
    for gy in 1..(template.h as i32 - 1) {
        for gx in 1..(template.w as i32 - 1) {
            let Some((tx_, ty_)) = template.gradient(gx, gy) else { continue };
            let x = (gx - cx) as f32;
            let y = (gy - cy) as f32;
            // dW/dp at x for W(x;p) = [(1+a) -b; b (1+a)]x + t, columns
            // ordered (a, b, tx, ty): d/da = x, d/db = -y for the x-row and
            // d/da = y, d/db = x for the y-row (independent of p — this warp
            // is linear in p, so the "at p=0" IC requirement holds for any p).
            // SD = grad(T) . dW/dp.
            let sd = [x * tx_ + y * ty_, -y * tx_ + x * ty_, tx_, ty_];
            let t = template.get(gx, gy).unwrap();
            pts.push(Pt { x, y, t, sd });
        }
    }
    if pts.len() < MIN_VALID_PIXELS {
        return None;
    }

    let mut p = init;
    for _ in 0..MAX_ITERS {
        let mut errs: Vec<(usize, f32)> = Vec::with_capacity(pts.len());
        for (i, pt) in pts.iter().enumerate() {
            let (wx, wy) = p.apply(pt.x, pt.y);
            if let Some(v) = image.sample_centered(wx, wy) {
                errs.push((i, v - pt.t));
            }
        }
        if errs.len() < MIN_VALID_PIXELS {
            return None;
        }
        let mut abs_sorted: Vec<f32> = errs.iter().map(|(_, e)| e.abs()).collect();
        abs_sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mad = abs_sorted[abs_sorted.len() / 2].max(0.5);
        let thresh = HUBER_MAD_MULT * mad;

        let mut h = [[0f32; 4]; 4];
        let mut g = [0f32; 4];
        for (i, e) in &errs {
            let sd = pts[*i].sd;
            let w = huber_weight(*e, thresh);
            for a in 0..4 {
                g[a] += w * sd[a] * e;
                for b in 0..4 {
                    h[a][b] += w * sd[a] * sd[b];
                }
            }
        }
        let delta = solve4(&h, &g)?;
        let mag = delta.iter().map(|d| d * d).sum::<f32>().sqrt();
        let dp = SimParams { re: 1.0 + delta[0], im: delta[1], tx: delta[2], ty: delta[3] };
        p = p.compose(&dp.inverse());
        if mag < CONVERGE_EPS {
            break;
        }
    }
    Some(p)
}

/// Coarse-to-fine IC-LK: builds a `levels`-deep pyramid of both images
/// (halving resolution each level) and refines the estimate from the
/// coarsest level down, rescaling translation ×2 between levels (scale and
/// rotation are resolution-independent; pixel translation isn't). Handles
/// motion too large for a single fine-resolution pass to converge to —
/// exactly the risk Gate A exists to test on real, compressed footage.
pub fn align_pyramidal(template: &GrayImage, image: &GrayImage, init: SimParams, levels: usize) -> Option<SimParams> {
    let levels = levels.max(1);
    let t_pyr = build_pyramid(GrayBuf::from_image(template), levels);
    let i_pyr = build_pyramid(GrayBuf::from_image(image), levels);
    let mut p = init;
    for level in (0..levels).rev() {
        p = align_level(&t_pyr[level], &i_pyr[level], p)?;
        if level > 0 {
            p.tx *= 2.0;
            p.ty *= 2.0;
        }
    }
    Some(p)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Luma};

    /// A textured (not flat) synthetic grayscale test pattern — alignment
    /// needs real gradient signal, same requirement the roadmap states for
    /// real photos in make_synthetic_reference.
    fn test_pattern(w: u32, h: u32) -> GrayImage {
        ImageBuffer::from_fn(w, h, |x, y| {
            let (fx, fy) = (x as f32, y as f32);
            let v = 128.0
                + 60.0 * ((fx / 17.0).sin() * (fy / 23.0).cos())
                + 40.0 * (((fx - 60.0).powi(2) + (fy - 40.0).powi(2)) / 900.0).cos()
                + 0.15 * fx
                - 0.1 * fy;
            Luma([v.clamp(0.0, 255.0) as u8])
        })
    }

    /// Warp `src` by the GIVEN truth params via bilinear resampling, i.e.
    /// synthesize what a camera/zoom applying `truth` to `src` would show —
    /// the exact inverse problem `align_pyramidal` has to solve. Both images
    /// are the same size (a real Ken Burns frame doesn't change render size).
    fn synth_target(src: &GrayImage, truth: SimParams) -> GrayImage {
        let buf = GrayBuf::from_image(src);
        let inv = truth.inverse();
        ImageBuffer::from_fn(src.width(), src.height(), |x, y| {
            let cx = src.width() as f32 / 2.0;
            let cy = src.height() as f32 / 2.0;
            let (sx, sy) = inv.apply(x as f32 - cx, y as f32 - cy);
            let v = buf.sample_centered(sx, sy).unwrap_or(128.0);
            Luma([v.clamp(0.0, 255.0) as u8])
        })
    }

    fn assert_close(recovered: SimParams, truth: SimParams, scale_tol_pct: f32, rot_tol_deg: f32, px_tol: f32) {
        let scale_err_pct = (recovered.scale() / truth.scale() - 1.0).abs() * 100.0;
        let rot_err_deg = (recovered.rotation_rad() - truth.rotation_rad()).to_degrees().abs();
        let pos_err_px = ((recovered.tx - truth.tx).powi(2) + (recovered.ty - truth.ty).powi(2)).sqrt();
        assert!(scale_err_pct <= scale_tol_pct, "scale error {scale_err_pct:.3}% > {scale_tol_pct}% (recovered {:?}, truth {:?})", recovered, truth);
        assert!(rot_err_deg <= rot_tol_deg, "rotation error {rot_err_deg:.3}deg > {rot_tol_deg}deg (recovered {:?}, truth {:?})", recovered, truth);
        assert!(pos_err_px <= px_tol, "position error {pos_err_px:.3}px > {px_tol}px (recovered {:?}, truth {:?})", recovered, truth);
    }

    // Phase 2's own "done when" tolerances (§ Phase 2, 20 synthetic
    // references): scale <= 1%, position <= 2px at 1080p, rotation <= 0.3deg.
    // These tests run at 256px (2.1's analysis resolution), same tolerances.

    #[test]
    fn recovers_a_small_zoom_and_pan() {
        let src = test_pattern(256, 256);
        let truth = SimParams { re: 1.06, im: 0.0, tx: 4.0, ty: -3.0 }; // 6% zoom, small pan
        let target = synth_target(&src, truth);
        let recovered = align_pyramidal(&src, &target, SimParams::IDENTITY, 3).expect("should converge");
        assert_close(recovered, truth, 1.0, 0.3, 2.0);
    }

    #[test]
    fn recovers_rotation() {
        let src = test_pattern(256, 256);
        let angle = 4.0_f32.to_radians();
        let truth = SimParams { re: angle.cos() * 1.02, im: angle.sin() * 1.02, tx: 1.0, ty: 2.0 };
        let target = synth_target(&src, truth);
        let recovered = align_pyramidal(&src, &target, SimParams::IDENTITY, 3).expect("should converge");
        assert_close(recovered, truth, 1.0, 0.3, 2.0);
    }

    #[test]
    fn pyramid_converges_on_a_large_punch_in_a_single_level_would_miss() {
        let src = test_pattern(256, 256);
        // A 35% zoom-in over one shot is a large single-level displacement
        // (way more than one pixel of gradient support at the edges) —
        // exactly what the pyramid exists to handle.
        let truth = SimParams { re: 1.35, im: 0.0, tx: -8.0, ty: 6.0 };
        let target = synth_target(&src, truth);
        let recovered = align_pyramidal(&src, &target, SimParams::IDENTITY, 4).expect("pyramid should converge");
        assert_close(recovered, truth, 1.0, 0.3, 2.0);
    }

    #[test]
    fn initializing_from_the_previous_frame_beats_identity_for_a_big_jump() {
        // Simulates the real per-shot loop: frame N's truth is close to
        // frame N-1's, so seeding from the previous result should converge
        // at least as reliably as identity on the same big warp.
        let src = test_pattern(256, 256);
        let prev = SimParams { re: 1.20, im: 0.0, tx: -5.0, ty: 4.0 };
        let truth = SimParams { re: 1.28, im: 0.0, tx: -6.0, ty: 5.0 };
        let target = synth_target(&src, truth);
        let recovered = align_pyramidal(&src, &target, prev, 3).expect("should converge");
        assert_close(recovered, truth, 1.0, 0.3, 2.0);
    }

    #[test]
    fn huber_weighting_resists_a_localized_occluder() {
        // A block of "moving text" (flat, unrelated intensity) covering a
        // corner of the target — the kind of contamination 2.4's doc
        // explicitly calls out ("text covering the photos"). The correct
        // warp should still be recoverable from the unoccluded majority.
        let src = test_pattern(256, 256);
        let truth = SimParams { re: 1.08, im: 0.0, tx: 3.0, ty: -2.0 };
        let mut target = synth_target(&src, truth);
        for y in 10..60 {
            for x in 160..250 {
                target.put_pixel(x, y, Luma([20]));
            }
        }
        let recovered = align_pyramidal(&src, &target, SimParams::IDENTITY, 3).expect("should still converge");
        assert_close(recovered, truth, 1.5, 0.5, 3.0); // slightly looser — real occlusion, not a clean signal
    }

    #[test]
    fn identity_stays_identity() {
        let src = test_pattern(256, 256);
        let recovered = align_pyramidal(&src, &src, SimParams::IDENTITY, 3).expect("should converge");
        assert_close(recovered, SimParams::IDENTITY, 0.2, 0.1, 0.5);
    }

}
