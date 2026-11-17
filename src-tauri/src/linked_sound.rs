//! A video's own sound is an ordinary audio layer linked to that video. While it
//! is `tucked` it has no row of its own and every edit of the video is repeated on
//! it, so picture and sound always read (and stay) together.

use crate::model::{Layer, LayerKind};

/// `(video id, tucked)` for an audio layer linked to a video, else `None`.
pub(crate) fn link_of(l: &Layer) -> Option<(u32, bool)> {
    match &l.kind {
        LayerKind::Audio { linked_video: Some(v), tucked, .. } => Some((*v, *tucked)),
        _ => None,
    }
}

/// Set (or clear) an audio layer's video link; no-op on other kinds.
pub(crate) fn set_link(l: &mut Layer, video: Option<u32>, tucked: bool) {
    if let LayerKind::Audio { linked_video, tucked: t, .. } = &mut l.kind {
        *linked_video = video;
        *t = tucked;
    }
}

/// A sound is tucked only when its flag is on AND its video is in this scope —
/// otherwise it must show as a row so it can never play invisibly.
pub(crate) fn is_tucked(layers: &[Layer], l: &Layer) -> bool {
    match link_of(l) {
        Some((v, true)) => layers.iter().any(|x| x.id == v),
        _ => false,
    }
}

/// Every sound linked to `video_id` (tucked or shown), in list order. Empty when
/// the video isn't in this scope.
pub(crate) fn linked_sounds(layers: &[Layer], video_id: u32) -> Vec<u32> {
    if !layers.iter().any(|l| l.id == video_id) {
        return Vec::new();
    }
    layers
        .iter()
        .filter(|l| matches!(link_of(l), Some((v, _)) if v == video_id))
        .map(|l| l.id)
        .collect()
}

/// `video_id`'s tucked sounds, in list order.
pub(crate) fn tucked_sounds(layers: &[Layer], video_id: u32) -> Vec<u32> {
    if !layers.iter().any(|l| l.id == video_id) {
        return Vec::new();
    }
    layers
        .iter()
        .filter(|l| matches!(link_of(l), Some((v, true)) if v == video_id))
        .map(|l| l.id)
        .collect()
}

/// Show a video's sound rows (`shown` = true): flag off, rows moved directly
/// above the video in their current order. Hide: flag on and nothing else moves.
/// `layer_id` may be the video or one of its linked sounds.
pub(crate) fn set_shown(layers: &mut Vec<Layer>, layer_id: u32, shown: bool) -> Result<(), String> {
    let video = layers
        .iter()
        .find(|l| l.id == layer_id)
        .and_then(|l| match &l.kind {
            LayerKind::Video { .. } => Some(l.id),
            _ => link_of(l).map(|(v, _)| v),
        })
        .ok_or("no linked sound")?;
    let ids = linked_sounds(layers, video);
    if ids.is_empty() {
        return Err("no linked sound".into());
    }
    for l in layers.iter_mut() {
        if ids.contains(&l.id) {
            set_link(l, Some(video), !shown);
        }
    }
    if shown {
        // One clip: the sound rows sit just above their video, keeping order.
        let mut sounds = Vec::new();
        let mut rest = Vec::new();
        for l in layers.drain(..) {
            if ids.contains(&l.id) {
                sounds.push(l);
            } else {
                rest.push(l);
            }
        }
        let at = rest.iter().position(|l| l.id == video).ok_or("no linked sound")? + 1;
        for (i, s) in sounds.into_iter().enumerate() {
            rest.insert(at + i, s);
        }
        *layers = rest;
    }
    Ok(())
}

/// Carry a video's tucked sounds along by the video's own edge moves: `ds`/`de`
/// are timeline ms, `din` the source in-point change. A pure move shifts the
/// range (keyframes travel); a trim moves the edges and clamps them to the
/// sound's own source and to the comp.
pub(crate) fn follow_range(layers: &mut [Layer], video_id: u32, ds: i64, de: i64, din: i64, comp_end: u32) {
    for id in tucked_sounds(layers, video_id) {
        let Some(l) = layers.iter_mut().find(|l| l.id == id) else { continue };
        if ds == de && din == 0 {
            let span = l.end_ms.saturating_sub(l.start_ms).max(crate::MIN_SPAN_MS);
            let max_start = comp_end.saturating_sub(span);
            let ns = (l.start_ms as i64 + ds).clamp(0, max_start as i64) as u32;
            crate::shift_layer_time(l, ns as i64 - l.start_ms as i64);
            continue;
        }
        let (dur_ms, old_in, speed) = match &l.kind {
            LayerKind::Audio { duration_ms, in_ms, speed, .. } => (*duration_ms, *in_ms, *speed),
            _ => continue,
        };
        let ni = (old_in as i64 + din).clamp(0, dur_ms as i64) as u32;
        let spd = if speed > 0.0 { speed as f64 } else { 1.0 };
        // When the in-point runs out of source, the head moves only as far as the
        // in-point did — moving it further would shift every sound under it.
        let moved_in = ni as i64 - old_in as i64;
        let ds = if moved_in != din { (moved_in as f64 / spd).round() as i64 } else { ds };
        let mut ns = (l.start_ms as i64 + ds).max(0) as u32;
        let mut ne = (l.end_ms as i64 + de).max(0) as u32;
        // The rest of the source from the new in-point is the longest it can play.
        let playable = (dur_ms.saturating_sub(ni) as f64 / spd).round() as u32;
        ne = ne.min(ns.saturating_add(playable.max(crate::MIN_SPAN_MS)));
        ne = ne.min(comp_end).max(crate::MIN_SPAN_MS).min(comp_end.max(crate::MIN_SPAN_MS));
        ns = ns.min(ne.saturating_sub(crate::MIN_SPAN_MS));
        l.start_ms = ns;
        l.end_ms = ne;
        if let LayerKind::Audio { in_ms, .. } = &mut l.kind {
            *in_ms = ni;
        }
    }
}

/// Where a new clip should be stacked when it goes "above" `above_id`: if that
/// is a video (or one of its shown sounds) with shown sound rows directly above
/// it, the top of that run — so a new clip never lands between a video and its
/// sound.
pub(crate) fn stack_anchor(layers: &[Layer], above_id: u32) -> u32 {
    let Some(pos) = layers.iter().position(|l| l.id == above_id) else { return above_id };
    let video_id = match &layers[pos].kind {
        LayerKind::Video { .. } => above_id,
        _ => match link_of(&layers[pos]) {
            Some((v, false)) => v,
            _ => return above_id,
        },
    };
    let Some(vpos) = layers.iter().position(|l| l.id == video_id) else { return above_id };
    let mut top = video_id;
    let mut run = Vec::new();
    for l in layers.iter().skip(vpos + 1) {
        if matches!(link_of(l), Some((v, false)) if v == video_id) {
            top = l.id;
            run.push(l.id);
        } else {
            break;
        }
    }
    if above_id == video_id || run.contains(&above_id) {
        top
    } else {
        above_id
    }
}

/// After a video is cut at `t_ms` into `video_id` and `second_id`: cut each
/// tucked sound that spans the cut too, and re-link every sound starting at or
/// after the cut to the second piece (shown sounds are re-linked, not cut).
pub(crate) fn after_split(layers: &mut Vec<Layer>, video_id: u32, second_id: u32, t_ms: u32, next_id: &mut u32) {
    let crossing: Vec<u32> = tucked_sounds(layers, video_id)
        .into_iter()
        .filter(|id| layers.iter().any(|l| l.id == *id && l.start_ms < t_ms && t_ms < l.end_ms))
        .collect();
    for sid in crossing {
        let Some(idx) = layers.iter().position(|l| l.id == sid) else { continue };
        if let Ok(tail) = crate::split_at(layers, idx, t_ms, next_id) {
            if let Some(l) = layers.iter_mut().find(|l| l.id == tail) {
                set_link(l, Some(second_id), true);
            }
        }
    }
    for l in layers.iter_mut() {
        if let Some((v, tucked)) = link_of(l) {
            if v == video_id && l.start_ms >= t_ms {
                set_link(l, Some(second_id), tucked);
            }
        }
    }
}

/// Sounds that must go with the videos being deleted: their tucked sounds. Shown
/// sounds are unlinked here (they stay as ordinary rows).
pub(crate) fn before_delete(layers: &mut [Layer], ids: &[u32]) -> Vec<u32> {
    let mut extra = Vec::new();
    for &v in ids {
        extra.extend(tucked_sounds(layers, v));
    }
    for l in layers.iter_mut() {
        if let Some((v, _)) = link_of(l) {
            if ids.contains(&v) {
                set_link(l, None, false);
            }
        }
    }
    extra
}

/// Copy each tucked sound of `video_id` for the duplicated video `copy_id`,
/// inserting the copy right after its original.
pub(crate) fn duplicate_tucked(layers: &mut Vec<Layer>, video_id: u32, copy_id: u32, next_id: &mut u32) {
    for id in tucked_sounds(layers, video_id) {
        let Some(pos) = layers.iter().position(|l| l.id == id) else { continue };
        let mut copy = layers[pos].clone();
        copy.id = *next_id;
        *next_id += 1;
        set_link(&mut copy, Some(copy_id), true);
        layers.insert(pos + 1, copy);
    }
}

/// Point the links inside a copied tree at the copied videos. `orig` and `copy`
/// are the same tree before/after `reassign_ids`, so ids map position by
/// position.
pub(crate) fn relink_copy(orig: &Layer, copy: &mut Layer) {
    fn walk(a: &Layer, b: &Layer, map: &mut Vec<(u32, u32)>) {
        map.push((a.id, b.id));
        if let (LayerKind::Group { children: ac }, LayerKind::Group { children: bc }) = (&a.kind, &b.kind) {
            for (x, y) in ac.iter().zip(bc.iter()) {
                walk(x, y, map);
            }
        }
    }
    let mut map = Vec::new();
    walk(orig, copy, &mut map);
    fn remap(l: &mut Layer, map: &[(u32, u32)]) {
        if let Some((v, tucked)) = link_of(l) {
            if let Some((_, nv)) = map.iter().find(|(o, _)| *o == v) {
                set_link(l, Some(*nv), tucked);
            }
        }
        if let LayerKind::Group { children } = &mut l.kind {
            for c in children {
                remap(c, map);
            }
        }
    }
    remap(copy, &map);
}

/// Retime a video's tucked sounds with its new speed: same speed, length rescaled
/// by the speed change, and the start offset scaled the same way (their offset ×
/// old ÷ new), so the same source time of picture and sound stays together.
pub(crate) fn follow_speed(layers: &mut [Layer], video_id: u32, old_speed: f32, new_speed: f32) {
    let Some(vstart) = layers.iter().find(|l| l.id == video_id).map(|l| l.start_ms) else { return };
    let old = if old_speed > 0.0 { old_speed as f64 } else { 1.0 };
    let new = if new_speed > 0.0 { new_speed as f64 } else { 1.0 };
    for id in tucked_sounds(layers, video_id) {
        let Some(l) = layers.iter_mut().find(|l| l.id == id) else { continue };
        let (cur, span) = match &l.kind {
            LayerKind::Audio { speed, .. } => {
                (*speed as f64, l.end_ms.saturating_sub(l.start_ms))
            }
            _ => continue,
        };
        let cur = if cur > 0.0 { cur } else { 1.0 };
        let span2 = ((span as f64 * cur / new).round() as u32).max(crate::MIN_SPAN_MS);
        let offset = l.start_ms as i64 - vstart as i64;
        let start = (vstart as i64 + (offset as f64 * old / new).round() as i64).max(0) as u32;
        l.start_ms = start;
        l.end_ms = start.saturating_add(span2).min(crate::MAX_COMP_MS);
        if let LayerKind::Audio { speed, .. } = &mut l.kind {
            *speed = new_speed;
        }
    }
}

/// Flip a video's tucked sounds with it, mirroring each range inside the video's
/// range (start offset becomes the video end minus the sound end) so the same
/// picture and sound still play together.
pub(crate) fn follow_reverse(layers: &mut [Layer], video_id: u32, reverse: bool) {
    let Some((vstart, vend)) = layers.iter().find(|l| l.id == video_id).map(|l| (l.start_ms, l.end_ms)) else {
        return;
    };
    for id in tucked_sounds(layers, video_id) {
        let Some(l) = layers.iter_mut().find(|l| l.id == id) else { continue };
        let differs = match &l.kind {
            LayerKind::Audio { reverse: r, .. } => *r != reverse,
            _ => continue,
        };
        if !differs {
            continue;
        }
        let (s, e) = (l.start_ms, l.end_ms);
        let ns = vstart.saturating_add(vend.saturating_sub(e));
        let ne = vstart.saturating_add(vend.saturating_sub(s));
        l.start_ms = ns;
        l.end_ms = ne;
        if let LayerKind::Audio { reverse: r, .. } = &mut l.kind {
            *r = reverse;
        }
    }
}

/// The eye is one clip: a tucked sound is hidden/shown with its video.
pub(crate) fn follow_hidden(layers: &mut [Layer], video_id: u32, hidden: bool) {
    for id in tucked_sounds(layers, video_id) {
        if let Some(l) = layers.iter_mut().find(|l| l.id == id) {
            l.hidden = hidden;
        }
    }
}

/// Grouping videos leaves their sounds outside the group as ordinary rows (a
/// sound inside a group doesn't play today). The link is kept for a possible
/// Hide after Explode.
pub(crate) fn untuck_members(layers: &mut [Layer], ids: &[u32]) {
    for &v in ids {
        for id in tucked_sounds(layers, v) {
            if let Some(l) = layers.iter_mut().find(|l| l.id == id) {
                set_link(l, Some(v), false);
            }
        }
    }
}

/// Drop every link to `video_id` (also inside groups): its old sound becomes an
/// ordinary row instead of a stale sound that could hide later.
pub(crate) fn release_sounds(layers: &mut [Layer], video_id: u32) {
    fn walk(l: &mut Layer, video_id: u32) {
        if let Some((v, _)) = link_of(l) {
            if v == video_id {
                set_link(l, None, false);
            }
        }
        if let LayerKind::Group { children } = &mut l.kind {
            for c in children.iter_mut() {
                walk(c, video_id);
            }
        }
    }
    for l in layers.iter_mut() {
        walk(l, video_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::*;

    pub(super) fn base(id: u32, s: u32, e: u32, kind: LayerKind) -> Layer {
        Layer { id, name: format!("l{id}"), start_ms: s, end_ms: e, kind, transform: Transform::at(0.0, 0.0),
                hidden: false, attach: None, effects: vec![], transition_in: None, transition_out: None }
    }
    /// A video whose source is exactly its range.
    fn video(id: u32, s: u32, e: u32) -> Layer {
        base(id, s, e, LayerKind::Video { src: "a.mp4".into(), width: 1920, height: 1080, duration_ms: e - s, in_ms: 0, speed: 1.0, reverse: false })
    }
    /// `video`'s sound, 20 s of source, starting at source time `in_ms`.
    fn sound(id: u32, video: u32, s: u32, e: u32, in_ms: u32, tucked: bool) -> Layer {
        base(id, s, e, LayerKind::Audio { src: "a.mp4".into(), duration_ms: 20_000, in_ms, volume: 1.0, speed: 1.0, reverse: false,
                                          fade_in_ms: 0, fade_out_ms: 0, linked_video: Some(video), tucked })
    }
    fn image(id: u32, s: u32, e: u32) -> Layer {
        base(id, s, e, LayerKind::Image { src: "p.png".into(), width: 10, height: 10, crop: None })
    }
    fn proj(layers: Vec<Layer>) -> Project {
        let mut p = Project::empty();
        p.duration_ms = 30_000;
        p.duration_set_by_user = true;
        p.layers = layers;
        p
    }
    fn get(p: &Project, id: u32) -> &Layer { p.layers.iter().find(|l| l.id == id).unwrap() }
    fn range(p: &Project, id: u32) -> (u32, u32) { let l = get(p, id); (l.start_ms, l.end_ms) }
    fn in_of(l: &Layer) -> u32 { match &l.kind { LayerKind::Audio { in_ms, .. } | LayerKind::Video { in_ms, .. } => *in_ms, _ => 0 } }
    fn link(p: &Project, id: u32) -> Option<(u32, bool)> { link_of(get(p, id)) }
    fn ids(p: &Project) -> Vec<u32> { p.layers.iter().map(|l| l.id).collect() }

    #[test]
    fn old_project_audio_loads_unlinked() {
        let k: LayerKind = serde_json::from_str(r#"{"kind":"audio","src":"a.mp3","durationMs":1000}"#).unwrap();
        assert!(matches!(k, LayerKind::Audio { linked_video: None, tucked: false, .. }));
    }

    #[test]
    fn adding_a_video_with_sound_tucks_the_sound_under_it() {
        let mut p = Project::empty();
        let vid = add_video_in(&mut p, "a.mp4".into(), 1920, 1080, 8_000, true, true);
        assert_eq!(p.layers.len(), 2);
        assert_eq!(p.layers.last().unwrap().id, vid); // the video stays the top (last) layer
        let s = &p.layers[0];
        assert_eq!((s.start_ms, s.end_ms), (0, 8_000));
        assert_eq!(link_of(s), Some((vid, true)));
        assert!(is_tucked(&p.layers, s));
    }

    #[test]
    fn adding_inside_a_group_leaves_the_sound_shown() {
        let mut p = Project::empty();
        let vid = add_video_in(&mut p, "a.mp4".into(), 1920, 1080, 8_000, true, false);
        assert_eq!(link_of(&p.layers[0]), Some((vid, false)));
    }

    #[test]
    fn adding_a_video_without_sound_adds_one_layer() {
        let mut p = Project::empty();
        add_video_in(&mut p, "a.mp4".into(), 1920, 1080, 8_000, false, true);
        assert_eq!(p.layers.len(), 1);
    }

    #[test]
    fn a_sound_whose_video_is_gone_is_not_tucked() {
        let p = proj(vec![sound(2, 1, 0, 5_000, 0, true)]);
        assert!(!is_tucked(&p.layers, &p.layers[0]));
        assert!(tucked_sounds(&p.layers, 1).is_empty());
    }

    #[test]
    fn showing_puts_every_sound_row_directly_above_its_video() {
        let mut p = proj(vec![
            video(1, 0, 10_000), image(5, 0, 3_000),
            sound(2, 1, 0, 4_000, 0, true), sound(3, 1, 4_000, 10_000, 4_000, true), image(6, 0, 3_000),
        ]);
        set_shown(&mut p.layers, 1, true).unwrap();
        assert_eq!(ids(&p), vec![1, 2, 3, 5, 6]);
        assert_eq!((link(&p, 2), link(&p, 3)), (Some((1, false)), Some((1, false))));
    }

    #[test]
    fn hiding_keeps_the_sounds_offset_and_trim() {
        let mut p = proj(vec![video(1, 0, 10_000), sound(2, 1, 1_500, 7_000, 1_500, false)]);
        set_shown(&mut p.layers, 2, false).unwrap(); // by the sound's id
        assert_eq!((range(&p, 2), in_of(get(&p, 2))), ((1_500, 7_000), 1_500));
        assert_eq!(link(&p, 2), Some((1, true)));
    }

    #[test]
    fn show_hide_errors_without_a_linked_sound() {
        let mut p = proj(vec![video(1, 0, 10_000)]);
        assert!(set_shown(&mut p.layers, 1, true).is_err());
    }

    #[test]
    fn moving_a_video_moves_its_tucked_sound_by_the_same_amount() {
        let mut p = proj(vec![video(1, 0, 5_000), sound(2, 1, 500, 5_000, 500, true)]);
        set_range_in(&mut p, 1, 2_000, 7_000, None).unwrap();
        assert_eq!((range(&p, 2), in_of(get(&p, 2))), ((2_500, 7_000), 500));
    }

    #[test]
    fn a_shown_sound_does_not_follow() {
        let mut p = proj(vec![video(1, 0, 5_000), sound(2, 1, 500, 5_000, 500, false)]);
        set_range_in(&mut p, 1, 2_000, 7_000, None).unwrap();
        assert_eq!(range(&p, 2), (500, 5_000));
    }

    #[test]
    fn head_trim_moves_the_sounds_start_and_in_point() {
        let mut p = proj(vec![video(1, 0, 5_000), sound(2, 1, 0, 5_000, 0, true)]);
        set_range_in(&mut p, 1, 1_000, 5_000, Some(1_000)).unwrap();
        assert_eq!((range(&p, 2), in_of(get(&p, 2))), ((1_000, 5_000), 1_000));
    }

    #[test]
    fn tail_trim_moves_the_sounds_end() {
        let mut p = proj(vec![video(1, 0, 5_000), sound(2, 1, 0, 5_000, 0, true)]);
        set_range_in(&mut p, 1, 0, 4_000, None).unwrap();
        assert_eq!(range(&p, 2), (0, 4_000));
    }

    #[test]
    fn a_trim_never_runs_the_sound_past_its_source() {
        let mut v = video(1, 0, 5_000);
        if let LayerKind::Video { duration_ms, .. } = &mut v.kind { *duration_ms = 20_000; }
        let mut s = sound(2, 1, 0, 5_000, 0, true);
        if let LayerKind::Audio { duration_ms, .. } = &mut s.kind { *duration_ms = 6_000; }
        let mut p = proj(vec![v, s]);
        set_range_in(&mut p, 1, 0, 8_000, None).unwrap();
        assert_eq!(range(&p, 2), (0, 6_000));
    }

    #[test]
    fn a_trim_never_leaves_the_sound_shorter_than_the_minimum_or_outside_the_comp() {
        let mut p = proj(vec![video(1, 0, 5_000), sound(2, 1, 4_000, 5_000, 4_000, true)]);
        p.duration_ms = 5_000;
        set_range_in(&mut p, 1, 4_900, 5_000, Some(4_900)).unwrap();
        let (s, e) = range(&p, 2);
        assert!(e >= s + MIN_SPAN_MS && e <= 5_000, "{s}..{e}");
    }

    #[test]
    fn extending_the_head_stops_the_sound_at_its_own_source_start() {
        // Moved right while shown: starts with the video but only 500 ms into its source.
        let mut v = video(1, 1_000, 5_000);
        if let LayerKind::Video { duration_ms, in_ms, .. } = &mut v.kind { *duration_ms = 20_000; *in_ms = 1_000; }
        let mut p = proj(vec![v, sound(2, 1, 1_000, 5_000, 500, true)]);
        set_range_in(&mut p, 1, 0, 5_000, Some(0)).unwrap();
        // Only 500 ms more sound exists, so what played at 1 s still plays at 1 s.
        assert_eq!((range(&p, 2), in_of(get(&p, 2))), ((500, 5_000), 0));
    }

    #[test]
    fn placing_a_new_video_brings_its_sound() {
        let mut p = Project::empty();
        let vid = add_video_in(&mut p, "a.mp4".into(), 1920, 1080, 4_000, true, true);
        let sid = p.layers[0].id;
        place_in_comp(&mut p, vid, 6_000, None, true, false).unwrap();
        assert_eq!((range(&p, vid), range(&p, sid)), ((6_000, 10_000), (6_000, 10_000)));
        assert_eq!(in_of(get(&p, sid)), 0);
    }

    #[test]
    fn the_make_room_shift_moves_a_tucked_sound_exactly_when_its_video_moves() {
        let mut p = proj(vec![
            video(1, 0, 5_000), sound(2, 1, 5_000, 6_000, 5_000, true), // starts after the insert point, video doesn't
            video(3, 5_000, 10_000), sound(4, 3, 4_000, 10_000, 0, true), // starts before it, video does
            video(9, 0, 3_000), // the new 3 s clip
        ]);
        place_in_comp(&mut p, 9, 5_000, None, true, true).unwrap();
        assert_eq!((range(&p, 1), range(&p, 2)), ((0, 5_000), (5_000, 6_000)));
        assert_eq!((range(&p, 3), range(&p, 4)), ((8_000, 13_000), (7_000, 13_000)));
    }

    #[test]
    fn a_new_clip_goes_above_a_video_and_its_shown_sound() {
        let mut p = proj(vec![image(3, 0, 3_000), video(1, 0, 5_000), sound(2, 1, 0, 5_000, 0, false)]);
        assert_eq!(stack_anchor(&p.layers, 1), 2);
        assert_eq!(stack_anchor(&p.layers, 2), 2);
        place_in_comp(&mut p, 3, 5_000, Some(1), true, false).unwrap();
        assert_eq!(ids(&p), vec![1, 2, 3]);
    }

    #[test]
    fn cutting_a_video_cuts_its_tucked_sound_at_the_same_time() {
        let mut p = proj(vec![video(1, 0, 10_000), sound(2, 1, 0, 10_000, 0, true)]);
        let mut next = 3;
        let v2 = split_at(&mut p.layers, 0, 4_000, &mut next).unwrap();
        after_split(&mut p.layers, 1, v2, 4_000, &mut next);
        let mut pieces: Vec<_> = p.layers.iter().filter(|l| matches!(l.kind, LayerKind::Audio { .. }))
            .map(|l| (l.start_ms, l.end_ms, in_of(l), link_of(l))).collect();
        pieces.sort();
        assert_eq!(pieces, vec![(0, 4_000, 0, Some((1, true))), (4_000, 10_000, 4_000, Some((v2, true)))]);
    }

    #[test]
    fn sound_pieces_go_with_the_part_of_the_picture_they_start_in() {
        let mut p = proj(vec![
            video(1, 0, 10_000),
            sound(2, 1, 0, 3_000, 0, true), sound(3, 1, 6_000, 9_000, 6_000, true),
            sound(4, 1, 3_000, 8_000, 3_000, false), sound(5, 1, 5_000, 6_000, 5_000, false),
        ]);
        let mut next = 6;
        let v2 = split_at(&mut p.layers, 0, 4_000, &mut next).unwrap();
        after_split(&mut p.layers, 1, v2, 4_000, &mut next);
        assert_eq!(p.layers.len(), 6); // only the video was cut
        assert_eq!((link(&p, 2), link(&p, 3)), (Some((1, true)), Some((v2, true))));
        assert_eq!((link(&p, 4), range(&p, 4)), (Some((1, false)), (3_000, 8_000)));
        assert_eq!(link(&p, 5), Some((v2, false)));
    }

    #[test]
    fn deleting_a_video_takes_its_tucked_sound_and_frees_a_shown_one() {
        let mut p = proj(vec![video(1, 0, 5_000), sound(2, 1, 0, 5_000, 0, true), video(3, 5_000, 9_000), sound(4, 3, 5_000, 9_000, 0, false)]);
        assert_eq!(before_delete(&mut p.layers, &[1, 3]), vec![2]);
        assert_eq!(link(&p, 4), None);
    }

    #[test]
    fn duplicating_a_video_copies_its_tucked_sound_into_the_copy() {
        let mut p = proj(vec![video(1, 0, 5_000), sound(2, 1, 500, 5_000, 500, true), video(7, 0, 5_000)]);
        let mut next = 8;
        duplicate_tucked(&mut p.layers, 1, 7, &mut next);
        assert_eq!((range(&p, 8), link(&p, 8)), ((500, 5_000), Some((7, true))));
        assert_eq!(link(&p, 2), Some((1, true)));
    }

    #[test]
    fn a_copied_group_keeps_its_sounds_tucked_into_the_copied_videos() {
        let g = base(10, 0, 5_000, LayerKind::Group { children: vec![video(11, 0, 5_000), sound(12, 11, 0, 5_000, 0, true)] });
        let mut copy = g.clone();
        let mut next = 20;
        reassign_ids(&mut copy, &mut next);
        relink_copy(&g, &mut copy);
        let LayerKind::Group { children } = &copy.kind else { panic!() };
        assert_eq!((children[0].id, link_of(&children[1])), (21, Some((21, true))));
    }

    #[test]
    fn speeding_up_keeps_trimmed_and_aligned_tucked_sounds_in_sync() {
        let mut p = proj(vec![video(1, 0, 10_000), sound(2, 1, 2_000, 10_000, 2_000, true), sound(3, 1, 0, 10_000, 0, true)]);
        follow_speed(&mut p.layers, 1, 1.0, 2.0);
        assert_eq!((range(&p, 2), range(&p, 3)), ((1_000, 5_000), (0, 5_000)));
        assert!(matches!(get(&p, 2).kind, LayerKind::Audio { speed, .. } if speed == 2.0));
    }

    #[test]
    fn reversing_mirrors_a_tucked_sound_inside_the_video() {
        let mut p = proj(vec![video(1, 0, 10_000), sound(2, 1, 2_000, 10_000, 2_000, true), sound(3, 1, 0, 10_000, 0, true)]);
        follow_reverse(&mut p.layers, 1, true);
        assert_eq!((range(&p, 2), range(&p, 3)), ((0, 8_000), (0, 10_000)));
        follow_reverse(&mut p.layers, 1, true); // already reversed: no second mirror
        assert_eq!(range(&p, 2), (0, 8_000));
    }

    #[test]
    fn the_eye_turns_a_tucked_sound_off_with_its_video_but_not_a_shown_one() {
        let mut p = proj(vec![video(1, 0, 5_000), sound(2, 1, 0, 5_000, 0, true), sound(3, 1, 0, 5_000, 0, false)]);
        follow_hidden(&mut p.layers, 1, true);
        assert!(get(&p, 2).hidden && !get(&p, 3).hidden);
    }

    #[test]
    fn grouping_a_video_leaves_its_sound_outside_and_shown() {
        let mut p = proj(vec![video(1, 0, 5_000), sound(2, 1, 0, 5_000, 0, true)]);
        untuck_members(&mut p.layers, &[1]);
        assert_eq!(link(&p, 2), Some((1, false)));
    }

    #[test]
    fn replacing_a_video_frees_its_sounds_even_inside_groups() {
        let g = base(10, 0, 5_000, LayerKind::Group { children: vec![sound(12, 1, 0, 5_000, 0, true)] });
        let mut p = proj(vec![video(1, 0, 5_000), sound(2, 1, 0, 5_000, 0, true), g]);
        release_sounds(&mut p.layers, 1);
        assert_eq!(link(&p, 2), None);
        let LayerKind::Group { children } = &get(&p, 10).kind else { panic!() };
        assert_eq!(link_of(&children[0]), None);
    }
}
