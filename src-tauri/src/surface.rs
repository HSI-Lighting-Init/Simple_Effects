//! 3D geometry for the `Shape3D` object and the image decals pinned to it.
//!
//! A `Shape3D` layer is an invisible box or cylinder. The evaluator turns it into
//! a `ShapeState` (its dimensions, 3D rotation, camera, and 2D placement, all
//! sampled at one instant). From that we produce two things:
//!
//!   * a `ResolvedShapeFrame` — the visible faces projected to 2D polygons, used
//!     to draw the selection wireframe and to hit-test the (otherwise invisible)
//!     shape; and
//!   * for each pinned image, a `ResolvedSurface` — the decal's rectangle placed
//!     on the shape's surface, rotated with the shape and perspective-projected
//!     to paint-ready quads.
//!
//! Corners are emitted as homogeneous screen coords `(hx, hy, hw)` (screen =
//! `hx/hw, hy/hw`) so the renderer can subdivide perspective-correctly. Decals
//! are baked into comp space (the shape's 2D move/scale/rotate folded in), since
//! each decal is its own image layer rather than a child of the shape's node.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::model::SurfaceShape;

/// A screen-space point (comp px for decals, local px for shape frames).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct Vec2 {
    pub x: f32,
    pub y: f32,
}

/// The visible faces of a `Shape3D`, projected to 2D. Each face is a closed
/// polygon (4 points for a box face). Used for the wireframe + hit area; the
/// rotation angles feed the inspector sliders.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ResolvedShapeFrame {
    pub faces: Vec<Vec<Vec2>>,
    pub rotation_x: f32,
    pub rotation_y: f32,
    pub rotation_z: f32,
}

/// A pinned layer projected onto the shape: paint-ready quads (empty if the
/// decal faces away from the camera), plus the placement sampled at this time
/// (for the inspector's sliders).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ResolvedSurface {
    pub quads: Vec<SurfaceQuad>,
    pub u: f32,
    pub v: f32,
    pub scale: f32,
    pub rotation: f32,
}

/// One projected quad. Corners are in texture-UV order: `[(0,0),(1,0),(1,1),(0,1)]`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct SurfaceQuad {
    pub corners: Vec<QuadVertex>,
    pub opacity: f32,
    pub subdiv: u32,
}

/// A projected quad corner: homogeneous screen position + texture coordinate.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct QuadVertex {
    pub hx: f32,
    pub hy: f32,
    pub hw: f32,
    pub u: f32,
    pub v: f32,
}

/// A `Shape3D` resolved at one instant: dimensions, 3D rotation, camera, and the
/// shape's own 2D placement (its layer transform). Built by the evaluator.
#[derive(Debug, Clone, Copy)]
pub struct ShapeState {
    pub shape: SurfaceShape,
    /// Box half-extents (px). For a cylinder, `hh` is the half-height.
    pub hw: f32,
    pub hh: f32,
    pub hd: f32,
    /// Cylinder radius (px) and visible circumference (degrees).
    pub radius: f32,
    pub coverage: f32,
    /// 3D rotation (degrees), sampled.
    pub rx: f32,
    pub ry: f32,
    pub rz: f32,
    pub perspective: f32,
    pub focal: f32,
    /// The shape's 2D placement (comp px / scale / degrees) — folded into decals.
    pub sx: f32,
    pub sy: f32,
    pub ssx: f32,
    pub ssy: f32,
    pub srot: f32,
}

type V3 = [f32; 3];

fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn scale3(a: V3, s: f32) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
fn norm3(a: V3) -> V3 {
    let len = (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt().max(1e-6);
    [a[0] / len, a[1] / len, a[2] / len]
}
fn len3(a: V3) -> f32 {
    (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt()
}

/// Rotate a point by Rz · Ry · Rx (Rx applied first), angles in degrees.
fn rotate(p: V3, rx_deg: f32, ry_deg: f32, rz_deg: f32) -> V3 {
    let (sx, cx) = rx_deg.to_radians().sin_cos();
    let (sy, cy) = ry_deg.to_radians().sin_cos();
    let (sz, cz) = rz_deg.to_radians().sin_cos();

    let (x0, mut y0, mut z0) = (p[0], p[1], p[2]);
    let y1 = cx * y0 - sx * z0;
    let z1 = sx * y0 + cx * z0;
    y0 = y1;
    z0 = z1;
    let x1 = cy * x0 + sy * z0;
    let z2 = -sy * x0 + cy * z0;
    let x0 = x1;
    z0 = z2;
    let x2 = cz * x0 - sz * y0;
    let y2 = sz * x0 + cz * y0;
    [x2, y2, z0]
}

/// Rotate then perspective-project to LOCAL homogeneous screen (no 2D placement).
/// Returns `(hx, hy, hw)` with screen = `(hx/hw, hy/hw)`.
fn project_local(p: V3, st: &ShapeState) -> (f32, f32, f32) {
    let r = rotate(p, st.rx, st.ry, st.rz);
    let denom = (1.0 - st.perspective * (r[2] / st.focal)).max(0.05);
    (r[0], r[1], denom)
}

/// Project a local point all the way to a comp-space screen point (rotation,
/// perspective, then the shape's 2D placement).
fn project_baked(p: V3, st: &ShapeState) -> Vec2 {
    let (hx, hy, hw) = project_local(p, st);
    let (hx, hy, hw) = bake_2d(hx, hy, hw, st);
    Vec2 { x: hx / hw, y: hy / hw }
}

/// Fold the shape's 2D placement (scale, rotation, translate) into a homogeneous
/// point, keeping it perspective-correct (the 2D map is linear, so it commutes
/// with the divide). Produces comp-space homogeneous coords.
fn bake_2d(hx: f32, hy: f32, hw: f32, st: &ShapeState) -> (f32, f32, f32) {
    let (s, c) = st.srot.to_radians().sin_cos();
    // L = rotate(srot) * scale(ssx, ssy)
    let l00 = c * st.ssx;
    let l01 = -s * st.ssy;
    let l10 = s * st.ssx;
    let l11 = c * st.ssy;
    let nx = l00 * hx + l01 * hy + st.sx * hw;
    let ny = l10 * hx + l11 * hy + st.sy * hw;
    (nx, ny, hw)
}

/// Z of a normal after the shape's 3D rotation (> 0 ⇒ facing the +Z camera).
fn rotated_normal_z(n: V3, st: &ShapeState) -> f32 {
    rotate(n, st.rx, st.ry, st.rz)[2]
}

/// Box face basis in local space: `(origin corner, u-axis, v-axis, normal)`.
/// Face order: 0 front, 1 back, 2 left, 3 right, 4 top, 5 bottom.
fn box_face_basis(st: &ShapeState, face: u32) -> (V3, V3, V3, V3) {
    let (hw, hh, hd) = (st.hw, st.hh, st.hd);
    match face {
        0 => ([-hw, -hh, hd], [2.0 * hw, 0.0, 0.0], [0.0, 2.0 * hh, 0.0], [0.0, 0.0, 1.0]),
        1 => ([hw, -hh, -hd], [-2.0 * hw, 0.0, 0.0], [0.0, 2.0 * hh, 0.0], [0.0, 0.0, -1.0]),
        2 => ([-hw, -hh, -hd], [0.0, 0.0, 2.0 * hd], [0.0, 2.0 * hh, 0.0], [-1.0, 0.0, 0.0]),
        3 => ([hw, -hh, hd], [0.0, 0.0, -2.0 * hd], [0.0, 2.0 * hh, 0.0], [1.0, 0.0, 0.0]),
        4 => ([-hw, -hh, -hd], [2.0 * hw, 0.0, 0.0], [0.0, 0.0, 2.0 * hd], [0.0, -1.0, 0.0]),
        _ => ([-hw, hh, hd], [2.0 * hw, 0.0, 0.0], [0.0, 0.0, -2.0 * hd], [0.0, 1.0, 0.0]),
    }
}

/// The shape's visible faces as projected 2D polygons (local space), for the
/// selection wireframe + hit area.
pub fn shape_frame(st: &ShapeState) -> ResolvedShapeFrame {
    let mut faces: Vec<Vec<Vec2>> = Vec::new();
    let to_screen = |p: V3| -> Vec2 {
        let (hx, hy, hw) = project_local(p, st);
        Vec2 { x: hx / hw, y: hy / hw }
    };

    match st.shape {
        SurfaceShape::Box => {
            for f in 0..6u32 {
                let (o, ua, va, n) = box_face_basis(st, f);
                if rotated_normal_z(n, st) <= 0.0 {
                    continue;
                }
                let c0 = o;
                let c1 = add(o, ua);
                let c2 = add(add(o, ua), va);
                let c3 = add(o, va);
                faces.push(vec![to_screen(c0), to_screen(c1), to_screen(c2), to_screen(c3)]);
            }
        }
        SurfaceShape::Cylinder => {
            const SEG: usize = 48;
            let cov = st.coverage.clamp(1.0, 360.0).to_radians();
            // One ribbon per visible segment (so the silhouette reads correctly).
            for k in 0..SEG {
                let a0 = -cov / 2.0 + cov * (k as f32 / SEG as f32);
                let a1 = -cov / 2.0 + cov * ((k + 1) as f32 / SEG as f32);
                let am = (a0 + a1) / 2.0;
                let n = [am.sin(), 0.0, am.cos()];
                if rotated_normal_z(n, st) <= 0.0 {
                    continue;
                }
                let (s0, c0) = a0.sin_cos();
                let (s1, c1) = a1.sin_cos();
                let r = st.radius;
                let top0 = [r * s0, -st.hh, r * c0];
                let top1 = [r * s1, -st.hh, r * c1];
                let bot1 = [r * s1, st.hh, r * c1];
                let bot0 = [r * s0, st.hh, r * c0];
                faces.push(vec![
                    to_screen(top0),
                    to_screen(top1),
                    to_screen(bot1),
                    to_screen(bot0),
                ]);
            }
        }
    }

    ResolvedShapeFrame { faces, rotation_x: st.rx, rotation_y: st.ry, rotation_z: st.rz }
}

/// Place a pinned image (decal) on the shape's surface and project it. Returns
/// empty quads when the decal faces away from the camera. A box decal is a flat
/// rectangle on the chosen face; a cylinder decal is a curved band that wraps
/// around the surface (subdivided so it bends, back-facing parts culled).
pub fn decal_surface(
    st: &ShapeState,
    face: u32,
    u: f32,
    v: f32,
    scale: f32,
    rotation: f32,
    img_w: f32,
    img_h: f32,
) -> ResolvedSurface {
    let quads = match st.shape {
        SurfaceShape::Box => decal_on_box(st, face, u, v, scale, rotation, img_w, img_h),
        SurfaceShape::Cylinder => decal_on_cylinder(st, u, v, scale, img_w, img_h),
    };
    ResolvedSurface { quads, u, v, scale, rotation }
}

/// A flat rectangular decal on one box face.
fn decal_on_box(
    st: &ShapeState,
    face: u32,
    u: f32,
    v: f32,
    scale: f32,
    rotation: f32,
    img_w: f32,
    img_h: f32,
) -> Vec<SurfaceQuad> {
    let aspect = (img_h / img_w.max(1.0)).max(1e-3);
    let (o, ua, va, n) = box_face_basis(st, face.min(5));
    if rotated_normal_z(n, st) <= 0.0 {
        return vec![];
    }
    let center = add(add(o, scale3(ua, u)), scale3(va, v));
    let (ux, uy, ref_px) = (norm3(ua), norm3(va), len3(ua));

    let dw = scale * ref_px;
    let dh = dw * aspect;
    let (sr, cr) = rotation.to_radians().sin_cos();
    // Corner offsets (px) in face space: TL, TR, BR, BL.
    let offs = [
        (-dw / 2.0, -dh / 2.0, 0.0, 0.0),
        (dw / 2.0, -dh / 2.0, 1.0, 0.0),
        (dw / 2.0, dh / 2.0, 1.0, 1.0),
        (-dw / 2.0, dh / 2.0, 0.0, 1.0),
    ];
    let mut corners = Vec::with_capacity(4);
    for (ox, oy, tu, tv) in offs {
        let rx = ox * cr - oy * sr;
        let ry = ox * sr + oy * cr;
        let p = add(center, add(scale3(ux, rx), scale3(uy, ry)));
        let (hx, hy, hw) = bake_2d_point(p, st);
        corners.push(QuadVertex { hx, hy, hw, u: tu, v: tv });
    }
    vec![SurfaceQuad { corners, opacity: 1.0, subdiv: 4 }]
}

/// A curved band decal that wraps around the cylinder. `scale` sizes it relative
/// to the cylinder height (1.0 = full height); the arc it covers is derived from
/// the image's aspect ratio so it isn't stretched. `u` is the centre angle
/// (0..1 over coverage), `v` the vertical centre.
fn decal_on_cylinder(
    st: &ShapeState,
    u: f32,
    v: f32,
    scale: f32,
    img_w: f32,
    img_h: f32,
) -> Vec<SurfaceQuad> {
    let height = 2.0 * st.hh;
    let band_h = (scale * height).max(1.0);
    let aspect_w = (img_w / img_h.max(1.0)).max(1e-3); // width / height
    let cov = st.coverage.clamp(1.0, 360.0).to_radians();
    // Arc the image spans, aspect-preserved, clamped so it can't overlap itself.
    let arc = (band_h * aspect_w / st.radius.max(1.0)).min(cov);

    let center_angle = -cov / 2.0 + u.clamp(0.0, 1.0) * cov;
    let cy = (v - 0.5) * height;
    let (y0, y1) = (cy - band_h / 2.0, cy + band_h / 2.0);

    const N: usize = 24;
    let r = st.radius;
    let mut quads = Vec::new();
    for k in 0..N {
        let f0 = k as f32 / N as f32;
        let f1 = (k + 1) as f32 / N as f32;
        let a0 = center_angle - arc / 2.0 + arc * f0;
        let a1 = center_angle - arc / 2.0 + arc * f1;
        let am = (a0 + a1) / 2.0;
        if rotated_normal_z([am.sin(), 0.0, am.cos()], st) <= 0.0 {
            continue; // this slice faces away
        }
        let (s0, c0) = a0.sin_cos();
        let (s1, c1) = a1.sin_cos();
        let pts = [
            ([r * s0, y0, r * c0], f0, 0.0),
            ([r * s1, y0, r * c1], f1, 0.0),
            ([r * s1, y1, r * c1], f1, 1.0),
            ([r * s0, y1, r * c0], f0, 1.0),
        ];
        let mut corners = Vec::with_capacity(4);
        for (p, tu, tv) in pts {
            let (hx, hy, hw) = bake_2d_point(p, st);
            corners.push(QuadVertex { hx, hy, hw, u: tu, v: tv });
        }
        quads.push(SurfaceQuad { corners, opacity: 1.0, subdiv: 2 });
    }
    quads
}

/// Project a local point to comp-space homogeneous coords (rotation + perspective
/// + the shape's 2D placement).
fn bake_2d_point(p: V3, st: &ShapeState) -> (f32, f32, f32) {
    let (hx, hy, hw) = project_local(p, st);
    bake_2d(hx, hy, hw, st)
}

/// Inverse-map a comp-space point onto a projected quad's `(s, t)` (perspective
/// homography), or `None` if degenerate. `quad` is in UV order
/// `[(0,0),(1,0),(1,1),(0,1)]`.
fn inv_map_quad(quad: &[Vec2; 4], x: f32, y: f32) -> Option<(f32, f32)> {
    // Heckbert unit-square → quad homography, then invert and apply.
    let (p0, p1, p2, p3) = (quad[0], quad[1], quad[2], quad[3]);
    let dx1 = p1.x - p2.x;
    let dx2 = p3.x - p2.x;
    let dx3 = p0.x - p1.x + p2.x - p3.x;
    let dy1 = p1.y - p2.y;
    let dy2 = p3.y - p2.y;
    let dy3 = p0.y - p1.y + p2.y - p3.y;
    let (a, b, d, e, g, h);
    if dx3.abs() < 1e-6 && dy3.abs() < 1e-6 {
        a = p1.x - p0.x;
        b = p2.x - p1.x;
        d = p1.y - p0.y;
        e = p2.y - p1.y;
        g = 0.0;
        h = 0.0;
    } else {
        let den = dx1 * dy2 - dx2 * dy1;
        if den.abs() < 1e-9 {
            return None;
        }
        g = (dx3 * dy2 - dx2 * dy3) / den;
        h = (dx1 * dy3 - dx3 * dy1) / den;
        a = p1.x - p0.x + g * p1.x;
        b = p3.x - p0.x + h * p3.x;
        d = p1.y - p0.y + g * p1.y;
        e = p3.y - p0.y + h * p3.y;
    }
    // M = [[a,b,p0.x],[d,e,p0.y],[g,h,1]] maps (s,t,1) → screen. Invert it.
    let (c, f, i) = (p0.x, p0.y, 1.0_f32);
    let aa = e * i - f * h;
    let bb = -(d * i - f * g);
    let cc = d * h - e * g;
    let det = a * aa + b * bb + c * cc;
    if det.abs() < 1e-9 {
        return None;
    }
    let id = 1.0 / det;
    let m0 = aa * id;
    let m1 = (c * h - b * i) * id;
    let m2 = (b * f - c * e) * id;
    let m3 = bb * id;
    let m4 = (a * i - c * g) * id;
    let m5 = (c * d - a * f) * id;
    let m6 = cc * id;
    let m7 = (b * g - a * h) * id;
    let m8 = (a * e - b * d) * id;
    let su = m0 * x + m1 * y + m2;
    let sv = m3 * x + m4 * y + m5;
    let sw = m6 * x + m7 * y + m8;
    if sw.abs() < 1e-9 {
        return None;
    }
    Some((su / sw, sv / sw))
}

/// Find which face (and `(u, v)` on it) a comp-space point lands on — used to
/// drag/drop images onto the shape. Tests only front-facing surfaces and returns
/// the first hit. `None` = the point isn't over the shape.
pub fn pick_surface(st: &ShapeState, x: f32, y: f32) -> Option<(u32, f32, f32)> {
    match st.shape {
        SurfaceShape::Box => {
            for f in 0..6u32 {
                let (o, ua, va, n) = box_face_basis(st, f);
                if rotated_normal_z(n, st) <= 0.0 {
                    continue;
                }
                let quad = [
                    project_baked(o, st),
                    project_baked(add(o, ua), st),
                    project_baked(add(add(o, ua), va), st),
                    project_baked(add(o, va), st),
                ];
                if let Some((u, v)) = inv_map_quad(&quad, x, y) {
                    if (0.0..=1.0).contains(&u) && (0.0..=1.0).contains(&v) {
                        return Some((f, u, v));
                    }
                }
            }
            None
        }
        SurfaceShape::Cylinder => {
            const SEG: usize = 48;
            let cov = st.coverage.clamp(1.0, 360.0).to_radians();
            for k in 0..SEG {
                let a0 = -cov / 2.0 + cov * (k as f32 / SEG as f32);
                let a1 = -cov / 2.0 + cov * ((k + 1) as f32 / SEG as f32);
                let am = (a0 + a1) / 2.0;
                if rotated_normal_z([am.sin(), 0.0, am.cos()], st) <= 0.0 {
                    continue;
                }
                let (s0, c0) = a0.sin_cos();
                let (s1, c1) = a1.sin_cos();
                let r = st.radius;
                let quad = [
                    project_baked([r * s0, -st.hh, r * c0], st),
                    project_baked([r * s1, -st.hh, r * c1], st),
                    project_baked([r * s1, st.hh, r * c1], st),
                    project_baked([r * s0, st.hh, r * c0], st),
                ];
                if let Some((s, t)) = inv_map_quad(&quad, x, y) {
                    if (0.0..=1.0).contains(&s) && (0.0..=1.0).contains(&t) {
                        return Some((0, (k as f32 + s) / SEG as f32, t));
                    }
                }
            }
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn box_state() -> ShapeState {
        ShapeState {
            shape: SurfaceShape::Box,
            hw: 200.0,
            hh: 150.0,
            hd: 100.0,
            radius: 0.0,
            coverage: 360.0,
            rx: 0.0,
            ry: 0.0,
            rz: 0.0,
            perspective: 0.35,
            focal: 1000.0,
            sx: 0.0,
            sy: 0.0,
            ssx: 1.0,
            ssy: 1.0,
            srot: 0.0,
        }
    }

    #[test]
    fn box_head_on_shows_one_face() {
        let frame = shape_frame(&box_state());
        assert_eq!(frame.faces.len(), 1);
        assert_eq!(frame.faces[0].len(), 4);
    }

    #[test]
    fn box_turned_shows_more_faces() {
        let mut st = box_state();
        st.ry = 35.0;
        assert!(shape_frame(&st).faces.len() >= 2);
    }

    #[test]
    fn decal_on_front_is_visible_then_culled() {
        let st = box_state();
        let front = decal_surface(&st, 0, 0.5, 0.5, 0.5, 0.0, 100.0, 100.0);
        assert_eq!(front.quads.len(), 1);
        // The back face (1) points away at rest → culled.
        let back = decal_surface(&st, 1, 0.5, 0.5, 0.5, 0.0, 100.0, 100.0);
        assert_eq!(back.quads.len(), 0);
    }

    #[test]
    fn pick_hits_front_centre() {
        let st = box_state();
        // The comp origin is the box centre head-on → the front face's middle.
        let (face, u, v) = pick_surface(&st, st.sx, st.sy).expect("should hit front");
        assert_eq!(face, 0);
        assert!((u - 0.5).abs() < 0.1, "u={u}");
        assert!((v - 0.5).abs() < 0.1, "v={v}");
    }

    #[test]
    fn pick_misses_off_shape() {
        let st = box_state();
        assert!(pick_surface(&st, 99999.0, 99999.0).is_none());
    }

    #[test]
    fn cylinder_pick_is_on_front() {
        let mut st = box_state();
        st.shape = SurfaceShape::Cylinder;
        st.radius = 150.0;
        let (_face, u, _v) = pick_surface(&st, st.sx, st.sy).expect("should hit cylinder front");
        // The front of the (full-coverage) cylinder is the middle of the wrap.
        assert!((u - 0.5).abs() < 0.1, "u={u}");
    }

    #[test]
    fn decal_2d_placement_is_baked() {
        let mut st = box_state();
        st.sx = 500.0;
        st.sy = 300.0;
        let d = decal_surface(&st, 0, 0.5, 0.5, 0.5, 0.0, 100.0, 100.0);
        let c = d.quads[0].corners[0];
        // Screen x should land near the shape's comp position, not the origin.
        assert!((c.hx / c.hw) > 300.0);
    }
}
