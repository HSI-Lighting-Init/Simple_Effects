// Phase 1.2 (roadmap docs/TEMPLATE_EXTRACTOR_ROADMAP.md §6): `make_synthetic_reference`
// builds a random project through the engine's own editing API, exports it, and writes
// the project itself as `truth.json` beside the video — a reference whose exact answer
// is known, so Gate A's aligner (and everything downstream) has something to score
// against instead of eyeballing. Every generated reference should be vetted with
// audit_export before it "counts" — the caller's job (see the agent tool), not this
// module's.
//
// Scope for this first pass: background shots only (Ken Burns motion, transitions,
// fades, grade, occasional vignette/grain) — exactly what Gate A's 2.4 aligner measures.
// Floating elements and text are Phase 3/5 concerns with no tracker yet to consume
// synthetic ground truth for them; deferred rather than built ahead of need.
import type { Project } from "../bindings/Project";
import type { TransformEdit } from "../bindings/TransformEdit";
import { REGISTRY } from "./transitions/registry";
import { fitScale } from "./stylePacks";
import {
  newProject,
  setCompSize,
  setCompFps,
  setCompDuration,
  listDirImages,
  setLayerRange,
  editKeyframes,
  setLayerTransition,
  addEffect,
  keyEffect,
  saveTextFile,
} from "./api";

/** The slice of AgentCtx this module needs — kept narrow (not imported from
 *  agent/tools.ts) so an AgentCtx satisfies it structurally with no circular
 *  import, the same pattern stylePacks.ts's StyleIO uses.
 *
 *  `addMedia` self-commits (it's a thin wrapper over the app's own
 *  add-to-timeline flow, same as a human dropping a file) — call `project()`
 *  right after it to read the fresh layer back. Every other mutation here
 *  returns its own fresh Project instead; thread that through by hand and
 *  `commit()` it once at the end, before exporting — export captures whatever
 *  the live app is currently showing, which only reflects a `commit`. */
export interface SyntheticIO {
  project(): Project;
  commit(p: Project): Promise<void>;
  importMedia(paths: string[]): Promise<void>;
  addMedia(index: number): Promise<number>;
  exportVideo(outPath: string, opts?: { format?: "mp4" | "webm"; level?: number; fps?: number }): Promise<string>;
}

export interface SyntheticRefOptions {
  /** Folder of real photos to draw shots from (needs texture — alignment can't
   *  work on flat colour). */
  photosDir: string;
  /** Deterministic seed — same seed + same photosDir contents reproduces the
   *  same reference. */
  seed: number;
  /** Number of shots (default 6). */
  shots?: number;
  /** Directory to write `<name>.mp4` + `<name>.truth.json` into. */
  outDir: string;
  /** Base filename, no extension (default `synthetic-<seed>`). */
  name?: string;
  /** Composition size (default 1080x1920, the vertical reel format Gate A's
   *  real reels are in) and fps (default 30). */
  width?: number;
  height?: number;
  fps?: number;
}

export interface SyntheticRefResult {
  videoPath: string;
  truthPath: string;
  project: Project;
  shots: number;
}

// --- deterministic PRNG (mulberry32) — small, dependency-free, reproducible. ---
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EASINGS: NonNullable<TransformEdit["easing"]>[] = ["linear", "easeIn", "easeOut", "easeInOut"];

/** E1 ground truth: a random cubic-bezier easing, sometimes overshooting
 *  (y1/y2 outside 0..1) like a motion-graphics "ease out back" bounce — so
 *  the 2.5 fitter has real overshoot segments to recover, not just the four
 *  named shapes. */
function randomBezier(rng: () => number): NonNullable<TransformEdit["easing"]> {
  const x1 = range(rng, 0.2, 0.6);
  const x2 = range(rng, 0.4, 0.8);
  const y1 = rng() < 0.5 ? range(rng, 0, 1) : range(rng, 1.1, 1.8);
  const y2 = rng() < 0.3 ? range(rng, 1.0, 1.4) : range(rng, 0, 1);
  return { bezier: { x1, y1, x2, y2 } };
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}
function range(rng: () => number, lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}
function shuffle<T>(rng: () => number, arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** One shot's random Ken Burns: 2-4 transform keys, random easing, scale
 *  1.0-1.3x the fit-to-frame baseline, pans ±5% of comp width, occasional
 *  rotation and a mid-shot punch-in. Mirrors the "+2% headroom hides hairline
 *  bars" trick stylePacks.ts's kenBurns already uses, for the same reason.
 *  Returns the project after its last mutation — every helper here does, so
 *  the caller can thread one `p` through the whole shot without re-fetching. */
async function animateShot(rng: () => number, layerId: number, startMs: number, endMs: number, fit: number, W: number, H: number): Promise<Project> {
  const s0 = fit * range(rng, 1.0, 1.3) * 1.02;
  const s1 = fit * range(rng, 1.0, 1.3) * 1.02;
  const panX = range(rng, -0.05, 0.05) * W;
  const panY = range(rng, -0.05, 0.05) * H;
  const rotate = rng() < 0.25 ? range(rng, -6, 6) : 0;
  const keys: { t: number; scale: number; x: number; y: number; rot: number }[] = [
    { t: startMs, scale: s0, x: W / 2 - panX / 2, y: H / 2 - panY / 2, rot: rotate ? -rotate / 2 : 0 },
    { t: endMs, scale: s1, x: W / 2 + panX / 2, y: H / 2 + panY / 2, rot: rotate ? rotate / 2 : 0 },
  ];
  // Occasional punch-in: a mid-shot key that jumps scale, held or eased fast.
  if (rng() < 0.2 && endMs - startMs > 800) {
    const t = Math.round(range(rng, startMs + 200, endMs - 200));
    const punch = Math.max(s0, s1) * range(rng, 1.05, 1.2);
    keys.splice(1, 0, { t, scale: punch, x: W / 2, y: H / 2, rot: 0 });
  }
  keys.sort((a, b) => a.t - b.t);
  let p: Project | undefined;
  for (const [i, k] of keys.entries()) {
    const edit: TransformEdit = { scaleX: k.scale, scaleY: k.scale, x: k.x, y: k.y, rotation: k.rot };
    if (i > 0) edit.easing = rng() < 0.2 ? randomBezier(rng) : pick(rng, EASINGS);
    p = await editKeyframes(layerId, k.t, edit, i === 0);
  }
  return p!; // keys always has >= 2 entries
}

/** Occasional fade in/out via opacity keyframes (not a transition engine). */
async function maybeFade(rng: () => number, layerId: number, startMs: number, endMs: number, p: Project): Promise<Project> {
  const dur = endMs - startMs;
  if (rng() < 0.3 && dur > 600) {
    const fadeMs = Math.min(400, Math.round(dur * 0.2));
    await editKeyframes(layerId, startMs, { opacity: 0, easing: "linear" }, false);
    p = await editKeyframes(layerId, startMs + fadeMs, { opacity: 1, easing: "linear" }, false);
  }
  if (rng() < 0.3 && dur > 600) {
    const fadeMs = Math.min(400, Math.round(dur * 0.2));
    await editKeyframes(layerId, endMs - fadeMs, { opacity: 1, easing: "linear" }, false);
    p = await editKeyframes(layerId, endMs, { opacity: 0, easing: "linear" }, false);
  }
  return p;
}

/** Random grade (brightness/contrast/saturate) and, sometimes, vignette/grain —
 *  via the same add_effect path the agent tool uses. */
async function gradeShot(rng: () => number, layerId: number, p: Project): Promise<Project> {
  const applyOne = async (kind: string, param: "amount" | "intensity", lo: number, hi: number) => {
    p = await addEffect(layerId, kind);
    const layer = p.layers.find((l) => l.id === layerId);
    const idx = layer ? layer.effects.length - 1 : 0;
    p = await keyEffect(layerId, idx, param, 0, range(rng, lo, hi), false);
  };
  await applyOne("brightness", "amount", 0.85, 1.2);
  await applyOne("contrast", "amount", 0.9, 1.3);
  await applyOne("saturate", "amount", 0.8, 1.4);
  if (rng() < 0.3) await applyOne("vignette", "intensity", 0.2, 0.6);
  else if (rng() < 0.3) await applyOne("filmgrain", "intensity", 0.05, 0.2);
  return p;
}

/** Build, export and write ground truth for one synthetic reference. The
 *  caller owns checkpointing/restoring the live project around this (it
 *  mutates the live app's project via `newProject()`, same as every other
 *  engine-API-driven tool). */
export async function makeSyntheticReference(opts: SyntheticRefOptions, io: SyntheticIO): Promise<SyntheticRefResult> {
  const rng = mulberry32(opts.seed);
  const photos = await listDirImages(opts.photosDir);
  if (photos.length < 3) throw new Error(`${opts.photosDir} has only ${photos.length} image(s) — need at least 3 for variety`);

  const shots = Math.max(1, opts.shots ?? 6);
  const W = opts.width ?? 1080;
  const H = opts.height ?? 1920;
  const fps = opts.fps ?? 30;

  await newProject();
  await setCompSize(W, H);
  await setCompFps(fps);
  await io.importMedia(photos);

  // Lay out shot spans first so setCompDuration (and every setLayerRange) has
  // its final target up front, rather than growing the comp shot by shot.
  const spans: { startMs: number; endMs: number }[] = [];
  let cursor = 0;
  for (let i = 0; i < shots; i++) {
    const span = Math.round(range(rng, 600, 4000));
    spans.push({ startMs: cursor, endMs: cursor + span });
    cursor += span;
  }
  await setCompDuration(cursor);

  const order = shuffle(rng, photos);
  let p = io.project();
  for (let i = 0; i < shots; i++) {
    const { startMs, endMs } = spans[i];
    const photoPath = order[i % order.length];
    const photoIndex = photos.indexOf(photoPath);

    const layerId = await io.addMedia(photoIndex); // self-commits
    if (layerId < 0) throw new Error(`addMedia failed for ${photoPath}`);
    p = io.project(); // fresh — addMedia already committed it
    const layer = p.layers.find((l) => l.id === layerId);
    const fit = layer ? fitScale(layer, W, H) ?? 1 : 1;

    p = await setLayerRange(layerId, startMs, endMs);
    p = await animateShot(rng, layerId, startMs, endMs, fit, W, H);
    p = await maybeFade(rng, layerId, startMs, endMs, p);
    p = await gradeShot(rng, layerId, p);

    if (i > 0 && rng() >= 0.5) {
      // Hard cut is the other 50% — no transition call at all.
      const engine = pick(rng, REGISTRY).id;
      const dur = Math.max(100, Math.min(500, Math.round((endMs - startMs) * 0.3)));
      p = await setLayerTransition(layerId, "in", "dissolve", dur, rng() < 0.5 ? 0 : 1, engine);
    }
  }

  const base = opts.name ?? `synthetic-${opts.seed}`;
  const videoPath = `${opts.outDir}/${base}.mp4`;
  const truthPath = `${opts.outDir}/${base}.truth.json`;

  await io.commit(p); // sync ref/React state + resolveImages + redraw before capture
  await io.exportVideo(videoPath, { format: "mp4", fps });
  await saveTextFile(truthPath, JSON.stringify(p, null, 2));

  return { videoPath, truthPath, project: p, shots };
}
