// The agent's tool registry: MCP-shaped entries (name, description, JSON-Schema
// inputSchema, handler) that are thin, validated adapters over the existing
// editing engine (src/lib/api.ts). The same registry feeds the in-app Claude
// loop today and can be re-exposed over MCP later without touching handlers.
//
// Scope is deliberately the "watchable scenario video" 80%: arrange, trim,
// transition, speed, text, basic colour, music. No LUT / chroma / stabilize /
// denoise / duck — those capabilities don't exist in the engine yet.
import type { Project } from "../bindings/Project";
import type { TransformEdit } from "../bindings/TransformEdit";
import type { EffectParam } from "../lib/api";
import { REGISTRY } from "../lib/transitions/registry";
import { STYLE_PACKS, stylePackById, applyStylePack } from "../lib/stylePacks";
import { GPU_FX } from "../lib/effects";
import { makeSyntheticReference } from "../lib/synthetic";
import { rebuildFromAnalysis, type TemplateAnalysis as RebuildTemplateAnalysis } from "../lib/rebuildFromAnalysis";
import { matchTransition } from "../lib/transitionMatch";
import { submitPhrasings, submitTextLines, type ElementTypePhrasing, type TextLineReading } from "./extraction";
import {
  setCompSize,
  setCompDuration,
  setCompFps,
  setLayerRange,
  splitLayer,
  deleteLayer,
  setLayerTransition,
  setClipSpeed,
  addEffect,
  keyEffect,
  addTextLayer,
  setAudioVolume,
  setAudioFade,
  editKeyframes,
  createBeforeAfter,
  createCarouselVideo,
  auditExport,
  alignReference,
  fitBackground,
  detectCuts,
  analyzeReference,
  saveProjectFile,
  openProjectFile,
  startSamService,
  samServiceStatus,
  stopSamService,
} from "../lib/api";

/** One selected source asset the agent may place. */
export interface MediaAsset {
  path: string;
  kind: "image" | "video" | "audio";
  durationMs: number;
  width: number;
  height: number;
}

/** Everything a handler needs from the live app. Mutating handlers call an
 *  api.ts function then `commit` the returned project so the UI updates live. */
export interface AgentCtx {
  project(): Project;
  commit(p: Project): Promise<void>;
  media: MediaAsset[];
  /** Add a selected asset to the timeline; resolves to the new layer id. */
  addMedia(index: number): Promise<number>;
  /** Render one frame at `tMs` exactly as it exports, `shortSide` px on the short
   *  edge; resolves to an image data URL. */
  renderPreview(tMs: number, shortSide?: number): Promise<string>;
  /** Render several frames tiled into one labeled image (data URL). */
  contactSheet(times: number[], shortSide?: number): Promise<string>;
  /** Render the whole comp to a real MP4/WebM file on disk (the actual encode,
   *  not a preview) and mux its audio. Resolves to the saved path. */
  exportVideo(outPath: string, opts?: { format?: "mp4" | "webm"; level?: number; fps?: number }): Promise<string>;
  /** Bring files into the media bin (so `media` / add_media_layer can use them). */
  importMedia(paths: string[]): Promise<void>;
  /** Save a named restore point of the whole project; resolves to its path. */
  checkpoint(name: string): Promise<string>;
  /** Roll back to a named checkpoint; false when it doesn't exist. */
  restore(name: string): Promise<boolean>;
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;
  log(text: string): void;
}

/** Split an image data URL into its mime type and base64 payload. */
export function splitDataUrl(url: string): { mime: string; data: string } {
  const m = /^data:([^;,]+);base64,/.exec(url);
  return { mime: m ? m[1] : "image/png", data: m ? url.slice(m[0].length) : url };
}

export type ToolResult = { text?: string; image?: string; isError?: boolean };
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: AgentCtx) => Promise<ToolResult>;
}

// --- arg coercion (no `any` at the boundary) ---
const num = (v: unknown, d = 0): number => (typeof v === "number" && isFinite(v) ? v : d);
const int = (v: unknown, d = 0): number => Math.round(num(v, d));
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const ok = (text: string): ToolResult => ({ text });
const err = (text: string): ToolResult => ({ text, isError: true });

const findLayer = (p: Project, id: number) => p.layers.find((l) => l.id === id);
const notFound = (id: number) => err(`layer ${id} not found — call get_timeline to list current layer ids`);

// Basic colour effects (kept for list_effects' human-readable notes / ranges).
const COLOR: Record<string, { param: "amount" | "radius" | "degrees"; lo: number; hi: number; note: string }> = {
  brightness: { param: "amount", lo: 0, hi: 3, note: "1 = unchanged, <1 darker, >1 brighter" },
  contrast: { param: "amount", lo: 0, hi: 3, note: "1 = unchanged" },
  saturate: { param: "amount", lo: 0, hi: 3, note: "1 = unchanged, 0 = greyscale" },
  hue: { param: "degrees", lo: -180, hi: 180, note: "degrees of hue rotation" },
  blur: { param: "radius", lo: 0, hi: 100, note: "blur radius in px" },
  grayscale: { param: "amount", lo: 0, hi: 1, note: "0..1 amount" },
  invert: { param: "amount", lo: 0, hi: 1, note: "0..1 amount" },
};

// GPU-overlay kind name -> gpuOverlay.frag effect index (mirrors Effect::default_of).
const GPU_KIND_INDEX: Record<string, number> = {
  caustics: 1, lensflare: 2, sparkle: 3, heathaze: 4, filmgrain: 5,
  vignette: 6, shimmer: 7, aurora: 8, fog: 9, flap: 10,
};

// Every kind add_effect accepts, with the params it can be keyed at (name ->
// range/note) — mirrors Rust's `effect_track_mut` exactly, reusing the same
// ranges the Inspector's sliders use (GPU_FX) so nothing drifts out of sync.
// Params NOT listed here (wipe's angle/invert, shinyclouds'/gpu-overlay's tint,
// tint2, blend, pos) are plain fields only `default_of` sets — no API animates
// them yet, so add_effect can't either; that's a pre-existing engine gap, not
// something this tool works around.
const EFFECT_PARAMS: Record<string, Record<string, { lo: number; hi: number; note?: string }>> = {
  ...Object.fromEntries(Object.entries(COLOR).map(([kind, c]) => [kind, { [c.param]: { lo: c.lo, hi: c.hi, note: c.note } }])),
  wipe: {
    position: { lo: 0, hi: 1, note: "0..1 sweep progress" },
    softness: { lo: 0, hi: 1, note: "0..1 edge feather" },
  },
  // Fully static (side/depth/seed/toothCount/paperWidth/paperColor) — no Track
  // fields to key, same gap as wipe's angle/invert. Listed with no params so
  // add_effect still accepts the kind (with its default_of starting values).
  tornedge: {},
  shinyclouds: {
    intensity: { lo: 0, hi: 2 }, scale: { lo: 0.5, hi: 5 }, speed: { lo: 0, hi: 3 },
    complexity: { lo: 1, hi: 8 }, contrast: { lo: 1, hi: 4 }, brightness: { lo: -0.5, hi: 0.5 }, opacity: { lo: 0, hi: 1 },
  },
  ...Object.fromEntries(
    Object.entries(GPU_KIND_INDEX).map(([kind, idx]) => [
      kind,
      Object.fromEntries(GPU_FX[idx].sliders.map((s) => [s.key, { lo: s.min, hi: s.max, note: s.label }])),
    ])
  ),
};

function timelineSummary(p: Project) {
  return {
    durationMs: p.durationMs,
    fps: p.fps,
    resolution: `${p.width}x${p.height}`,
    layers: p.layers.map((l) => ({
      id: l.id,
      name: l.name,
      kind: l.kind.kind,
      startMs: l.startMs,
      endMs: l.endMs,
      effects: l.effects.map((e) => e.kind),
      transitionIn: l.transitionIn?.engine ?? null,
      transitionInDurMs: l.transitionIn?.durMs ?? null,
      transitionInDirection: l.transitionIn?.direction ?? null,
      transitionOut: l.transitionOut?.engine ?? null,
    })),
  };
}

export const TOOLS: ToolDef[] = [
  {
    name: "get_timeline",
    description: "Return the current project: duration, fps, resolution, and every layer (id, name, kind, start/end ms, effects, transitions). Call this before editing and whenever you need current layer ids.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_a, ctx) => ok(JSON.stringify(timelineSummary(ctx.project()))),
  },
  {
    name: "list_media",
    description: "List the source assets the user selected for this scenario, with index, kind, duration (ms) and pixel size. Use add_media_layer with an index to place one.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_a, ctx) =>
      ok(JSON.stringify(ctx.media.map((m, i) => ({ index: i, kind: m.kind, durationMs: m.durationMs, width: m.width, height: m.height, name: m.path.split(/[\\/]/).pop() })))),
  },
  {
    name: "list_effects",
    description: "List every effect kind add_effect accepts (colour/blur filters, plus the shinyclouds and GPU-overlay looks), each with its keyable parameter names and ranges. Only these exist — never invent a kind or param name.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () =>
      ok(JSON.stringify(
        Object.entries(EFFECT_PARAMS).map(([kind, params]) => ({
          kind,
          params: Object.entries(params).map(([param, r]) => ({ param, min: r.lo, max: r.hi, note: r.note })),
        }))
      )),
  },
  {
    name: "list_transitions",
    description: "List the transition engines you may use between/at clips (id + label + category). Use an id verbatim in set_transition.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => ok(JSON.stringify(REGISTRY.map((m) => ({ id: m.id, label: m.label, category: m.category })))),
  },
  {
    name: "set_composition",
    description: "Set the video's overall duration (ms), resolution and fps. DO THIS FIRST: set durationMs to the target length, and width/height to match the assets — vertical clips (e.g. 1080×1920, 9:16) need a vertical composition. Clips cannot extend past the composition duration, so this defines the canvas everything is built on.",
    inputSchema: {
      type: "object",
      properties: {
        durationMs: { type: "integer", description: "total video length in ms" },
        width: { type: "integer" },
        height: { type: "integer" },
        fps: { type: "number" },
      },
      additionalProperties: false,
    },
    handler: async (a, ctx) => {
      let p = ctx.project();
      if (a.width !== undefined && a.height !== undefined) p = await setCompSize(int(a.width), int(a.height));
      if (a.durationMs !== undefined) p = await setCompDuration(int(a.durationMs));
      if (a.fps !== undefined) p = await setCompFps(num(a.fps, 30));
      await ctx.commit(p);
      return ok(JSON.stringify({ durationMs: p.durationMs, resolution: `${p.width}x${p.height}`, fps: p.fps }));
    },
  },
  {
    name: "add_media_layer",
    description: "Place a selected source asset (by its list_media index) onto the timeline at the current playhead. Returns the new layer id. Then use set_layer_time to position/trim it. A video with sound also adds a synced audio layer.",
    inputSchema: {
      type: "object",
      properties: { mediaIndex: { type: "integer", description: "index from list_media" } },
      required: ["mediaIndex"],
      additionalProperties: false,
    },
    handler: async (a, ctx) => {
      const i = int(a.mediaIndex, -1);
      if (i < 0 || i >= ctx.media.length) return err(`mediaIndex ${i} out of range (0..${ctx.media.length - 1}) — call list_media`);
      const id = await ctx.addMedia(i);
      return ok(JSON.stringify({ layerId: id, kind: ctx.media[i].kind }));
    },
  },
  {
    name: "add_text",
    description: "Add a text layer (title/caption). Returns the new layer id. Position it on the timeline with the start/end you pass here.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        sizePx: { type: "number", description: "font height in px (default 120)" },
        startMs: { type: "integer" },
        endMs: { type: "integer" },
      },
      required: ["text", "startMs", "endMs"],
      additionalProperties: false,
    },
    handler: async (a, ctx) => {
      const text = str(a.text);
      if (!text) return err("text is empty");
      let p = await addTextLayer(text, num(a.sizePx, 120));
      const id = p.layers.length ? p.layers[p.layers.length - 1].id : null;
      if (id == null) return err("failed to add text layer");
      p = await setLayerRange(id, int(a.startMs), int(a.endMs));
      await ctx.commit(p);
      return ok(JSON.stringify({ layerId: id }));
    },
  },
  {
    name: "set_layer_time",
    description: "Set a layer's timeline span [startMs, endMs] (position + trim). For video/audio, inMs is the source in-point shown at the start (advances which part of the clip plays).",
    inputSchema: {
      type: "object",
      properties: {
        layerId: { type: "integer" },
        startMs: { type: "integer" },
        endMs: { type: "integer" },
        inMs: { type: "integer", description: "video/audio source in-point (optional)" },
      },
      required: ["layerId", "startMs", "endMs"],
      additionalProperties: false,
    },
    handler: async (a, ctx) => {
      const id = int(a.layerId);
      if (!findLayer(ctx.project(), id)) return notFound(id);
      const inMs = a.inMs === undefined ? undefined : int(a.inMs);
      await ctx.commit(await setLayerRange(id, int(a.startMs), int(a.endMs), inMs));
      return ok("ok");
    },
  },
  {
    name: "split_layer",
    description: "Cut a layer at tMs into two pieces; the second continues from the cut (video/audio keep their source in-point).",
    inputSchema: {
      type: "object",
      properties: { layerId: { type: "integer" }, tMs: { type: "integer" } },
      required: ["layerId", "tMs"],
      additionalProperties: false,
    },
    handler: async (a, ctx) => {
      const id = int(a.layerId);
      if (!findLayer(ctx.project(), id)) return notFound(id);
      try {
        await ctx.commit(await splitLayer(id, int(a.tMs)));
      } catch (e) {
        return err(`split failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return ok("ok");
    },
  },
  {
    name: "delete_layer",
    description: "Delete a layer by id.",
    inputSchema: {
      type: "object",
      properties: { layerId: { type: "integer" } },
      required: ["layerId"],
      additionalProperties: false,
    },
    handler: async (a, ctx) => {
      const id = int(a.layerId);
      if (!findLayer(ctx.project(), id)) return notFound(id);
      await ctx.commit(await deleteLayer(id));
      return ok("ok");
    },
  },
  {
    name: "set_transition",
    description: "Set a layer's in or out transition. engine is an id from list_transitions. Use transitions sparingly; prefer hard cuts for pace.",
    inputSchema: {
      type: "object",
      properties: {
        layerId: { type: "integer" },
        slot: { type: "string", enum: ["in", "out"] },
        engine: { type: "string" },
        durMs: { type: "integer", description: "transition length in ms (e.g. 400)" },
        direction: { type: "integer", description: "0-3 for directional engines (default 0)" },
      },
      required: ["layerId", "slot", "engine", "durMs"],
      additionalProperties: false,
    },
    handler: async (a, ctx) => {
      const id = int(a.layerId);
      if (!findLayer(ctx.project(), id)) return notFound(id);
      const engine = str(a.engine);
      if (!REGISTRY.some((m) => m.id === engine)) return err(`unknown transition '${engine}' — call list_transitions`);
      const slot = str(a.slot) === "out" ? "out" : "in";
      await ctx.commit(await setLayerTransition(id, slot, "dissolve", int(a.durMs, 400), int(a.direction), engine));
      return ok("ok");
    },
  },
  {
    name: "set_keyframe",
    description: "Set a keyframe on a layer's transform at an exact time — position (x/y), scale (scaleX/scaleY), rotation, or opacity. Only the fields you pass change. Call it at 2+ different times on the same layer to animate a custom move — e.g. a punch-in-then-back-out zoom (normal → zoomed at the midpoint → normal again), instead of apply_style's simple straight-line Ken Burns drift. Get the layer's current scale/position first (fit-to-frame scale = min(compWidth/imageWidth, compHeight/imageHeight)) so your keyframes start from where it already sits, not a jump. `easing` shapes the segment(s) this call creates (default easeInOut); it only takes effect on a NEW keyframe or the seed key — nudging an already-keyframed time's value without passing easing leaves that segment's shape alone. `easing: \"bezier\"` needs bezierX1/bezierY1/bezierX2/bezierY2 too — a custom timing curve like CSS cubic-bezier(x1,y1,x2,y2); y1/y2 may leave 0..1 for overshoot (e.g. 0.34,1.56,0.64,1 is a snappy 'ease out back' bounce past the target before settling).",
    inputSchema: {
      type: "object",
      properties: {
        layerId: { type: "integer" },
        tMs: { type: "integer" },
        x: { type: "number" },
        y: { type: "number" },
        scaleX: { type: "number" },
        scaleY: { type: "number" },
        rotation: { type: "number", description: "degrees" },
        opacity: { type: "number", description: "0..1" },
        easing: { type: "string", enum: ["linear", "easeIn", "easeOut", "easeInOut", "hold", "bezier"], description: "default easeInOut; hold = step (snaps to this value, no tween); bezier needs bezierX1/Y1/X2/Y2 too" },
        bezierX1: { type: "number" },
        bezierY1: { type: "number" },
        bezierX2: { type: "number" },
        bezierY2: { type: "number" },
      },
      required: ["layerId", "tMs"],
      additionalProperties: false,
    },
    handler: async (a, ctx) => {
      const id = int(a.layerId);
      if (!findLayer(ctx.project(), id)) return notFound(id);
      const edit: TransformEdit = {};
      for (const k of ["x", "y", "scaleX", "scaleY", "rotation", "opacity"] as const)
        if (typeof a[k] === "number" && isFinite(a[k] as number)) edit[k] = a[k] as number;
      if (!Object.keys(edit).length) return err("provide at least one of x/y/scaleX/scaleY/rotation/opacity");
      if (a.easing === "bezier") {
        const parts = [a.bezierX1, a.bezierY1, a.bezierX2, a.bezierY2];
        if (parts.some((v) => typeof v !== "number" || !isFinite(v))) {
          return err("easing \"bezier\" needs bezierX1/bezierY1/bezierX2/bezierY2");
        }
        const [x1, y1, x2, y2] = parts as number[];
        edit.easing = { bezier: { x1, y1, x2, y2 } };
      } else if (typeof a.easing === "string") {
        edit.easing = a.easing as TransformEdit["easing"];
      }
      await ctx.commit(await editKeyframes(id, int(a.tMs), edit, false));
      return ok("ok");
    },
  },
  {
    name: "set_speed",
    description: "Set an audio/video clip's playback speed (0.1..8, 1 = normal). Pitch is preserved.",
    inputSchema: {
      type: "object",
      properties: { layerId: { type: "integer" }, speed: { type: "number" } },
      required: ["layerId", "speed"],
      additionalProperties: false,
    },
    handler: async (a, ctx) => {
      const id = int(a.layerId);
      const l = findLayer(ctx.project(), id);
      if (!l) return notFound(id);
      if (l.kind.kind !== "video" && l.kind.kind !== "audio") return err(`layer ${id} is a ${l.kind.kind}; speed only applies to video/audio`);
      await ctx.commit(await setClipSpeed(id, num(a.speed, 1)));
      return ok("ok");
    },
  },
  {
    name: "add_effect",
    description: "Add one effect to a layer's stack — a basic colour/blur filter, or a GPU overlay (shinyclouds, or one of the 10 named gpu-overlay looks: caustics, lensflare, sparkle, heathaze, filmgrain, vignette, shimmer, aurora, fog, flap) — reachable directly here, not just through apply_style. kind + valid params/ranges come from list_effects; never invent either. params sets each named parameter's starting value (all optional — omit to use the kind's defaults); values outside list_effects' range are clamped.",
    inputSchema: {
      type: "object",
      properties: {
        layerId: { type: "integer" },
        kind: { type: "string", enum: Object.keys(EFFECT_PARAMS) },
        params: { type: "object", additionalProperties: { type: "number" }, description: "paramName -> value, e.g. {\"amount\": 1.4} for brightness, or {\"intensity\": 0.8, \"opacity\": 0.6} for a GPU overlay" },
      },
      required: ["layerId", "kind"],
      additionalProperties: false,
    },
    handler: async (a, ctx) => {
      const id = int(a.layerId);
      if (!findLayer(ctx.project(), id)) return notFound(id);
      const kind = str(a.kind);
      const validParams = EFFECT_PARAMS[kind];
      if (!validParams) return err(`unknown effect '${kind}' — call list_effects`);
      const raw = a.params && typeof a.params === "object" ? (a.params as Record<string, unknown>) : {};
      const applied: Record<string, number> = {};
      for (const [param, v] of Object.entries(raw)) {
        const range = validParams[param];
        if (!range) return err(`effect '${kind}' has no parameter '${param}' — call list_effects for its valid params`);
        if (typeof v !== "number" || !isFinite(v)) return err(`'${param}' must be a number`);
        applied[param] = Math.max(range.lo, Math.min(range.hi, v));
      }
      let p = await addEffect(id, kind);
      const layer = findLayer(p, id);
      const index = layer ? layer.effects.length - 1 : 0;
      for (const [param, value] of Object.entries(applied)) p = await keyEffect(id, index, param as EffectParam, 0, value, false);
      await ctx.commit(p);
      return ok(JSON.stringify({ added: kind, index, applied }));
    },
  },
  {
    name: "set_audio",
    description: "Adjust an audio layer: output level (volume, 1 = original) and start/end fades in ms.",
    inputSchema: {
      type: "object",
      properties: {
        layerId: { type: "integer" },
        volume: { type: "number" },
        fadeInMs: { type: "integer" },
        fadeOutMs: { type: "integer" },
      },
      required: ["layerId"],
      additionalProperties: false,
    },
    handler: async (a, ctx) => {
      const id = int(a.layerId);
      const l = findLayer(ctx.project(), id);
      if (!l) return notFound(id);
      if (l.kind.kind !== "audio") return err(`layer ${id} is a ${l.kind.kind}; set_audio only applies to audio`);
      if (a.volume !== undefined) await ctx.commit(await setAudioVolume(id, num(a.volume, 1)));
      if (a.fadeInMs !== undefined || a.fadeOutMs !== undefined) {
        const cur = l.kind.kind === "audio" ? l.kind : null;
        await ctx.commit(await setAudioFade(id, int(a.fadeInMs, cur?.fadeInMs ?? 0), int(a.fadeOutMs, cur?.fadeOutMs ?? 0)));
      }
      return ok("ok");
    },
  },
  {
    name: "validate_timeline",
    description: "Check for problems: layers outside the comp duration, zero/negative-length layers, empty timeline. Returns a list of issues (empty = clean).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_a, ctx) => {
      const p = ctx.project();
      const issues: string[] = [];
      if (p.layers.length === 0) issues.push("timeline is empty");
      for (const l of p.layers) {
        if (l.endMs <= l.startMs) issues.push(`layer ${l.id} (${l.name}) has non-positive length`);
        if (l.startMs < 0 || l.endMs > p.durationMs) issues.push(`layer ${l.id} (${l.name}) runs outside 0..${p.durationMs}ms`);
      }
      return ok(JSON.stringify({ issues }));
    },
  },
  {
    name: "render_preview",
    description: "Render the frame at tMs exactly as it will export, at real resolution (short side 360 / 720 / 1080, default 720). Use it to check one specific moment — a title, a transition, the end card. For an overview use contact_sheet.",
    inputSchema: {
      type: "object",
      properties: {
        tMs: { type: "integer" },
        resolution: { type: "integer", enum: [360, 720, 1080] },
      },
      required: ["tMs"],
      additionalProperties: false,
    },
    handler: async (a, ctx) => {
      try {
        return { image: await ctx.renderPreview(int(a.tMs), int(a.resolution, 720)) };
      } catch (e) {
        return err(`render failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  },
  {
    name: "contact_sheet",
    description: "Render several frames across the video into ONE labeled image grid to check pacing, transitions, grade consistency and titles at a glance. Default: 8 evenly spaced frames. Much cheaper than many render_preview calls.",
    inputSchema: {
      type: "object",
      properties: {
        times: { type: "array", items: { type: "integer" }, description: "exact frame times in ms (max 16)" },
        count: { type: "integer", description: "evenly spaced frames when times is omitted (2..16, default 8)" },
        resolution: { type: "integer", enum: [240, 360] },
      },
      additionalProperties: false,
    },
    handler: async (a, ctx) => {
      const dur = ctx.project().durationMs;
      let times = Array.isArray(a.times) ? a.times.filter((x): x is number => typeof x === "number") : [];
      if (!times.length) {
        const n = Math.max(2, Math.min(16, int(a.count, 8)));
        times = Array.from({ length: n }, (_, i) => Math.round((dur * (i + 0.5)) / n));
      }
      times = times.slice(0, 16).map((t) => Math.max(0, Math.min(dur, t)));
      try {
        return { image: await ctx.contactSheet(times, int(a.resolution, 240)) };
      } catch (e) {
        return err(`contact sheet failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  },
  {
    name: "export_video",
    description: "Render the WHOLE comp to a real MP4/WebM file on disk, with its audio muxed in — the actual deliverable, not a preview. This is a real encode (can take minutes for a full comp) — always check the look with contact_sheet/render_preview FIRST, this is the last step. Requires ffmpeg for MP4 (WebM needs nothing extra).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "absolute output file path, e.g. C:\\Users\\me\\Desktop\\out.mp4" },
        format: { type: "string", enum: ["mp4", "webm"], description: "default: inferred from path, else mp4" },
        quality: { type: "integer", enum: [1, 2, 3, 4, 5], description: "1 near-original/largest .. 5 highest compression/smallest (default 2)" },
        fps: { type: "number", description: "defaults to the comp's fps" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: async (a, ctx) => {
      const path = str(a.path);
      if (!path) return err("path is required — an absolute output file path");
      const format = a.format === "webm" || a.format === "mp4" ? a.format : /\.webm$/i.test(path) ? "webm" : "mp4";
      const level = Math.max(1, Math.min(5, int(a.quality, 2)));
      const fps = typeof a.fps === "number" && isFinite(a.fps) && a.fps > 0 ? a.fps : undefined;
      try {
        const saved = await ctx.exportVideo(path, { format, level, fps });
        return ok(`exported to ${saved}`);
      } catch (e) {
        return err(`export failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  },
  {
    name: "audit_export",
    description: "Check an already-exported video against the CURRENT project's image layers: every 250ms, does the frame actually look like whichever image layer(s) should be visible there (a luminance + colour fingerprint match)? Flags frames whose closest match is a different layer or nothing expected. Note (handoff §11.1, closed 2026-09-26): a flag is not proof of a bug — near-duplicate source images (same picture saved twice), a fade-from-black opening frame, and a mid-wipe-transition split frame all legitimately flag too; check the returned image sheet before assuming a real content swap. Only image-kind layers are checked (video/text/shapes have no single static source to fingerprint). verbose also returns every frame's numbers (not just flagged ones), useful for calibration.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "absolute path to the exported video file" },
        verbose: { type: "boolean", description: "include every scanned frame's numbers, not just flagged ones (default false)" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: async (a) => {
      const path = str(a.path);
      if (!path) return err("path is required — an absolute exported video file path");
      try {
        const report = await auditExport(path, a.verbose === true);
        const { sheet, ...rest } = report;
        return { text: JSON.stringify(rest), image: sheet ?? undefined };
      } catch (e) {
        return err(`audit failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  },
  {
    name: "create_before_after",
    description: "Template: a before/after reveal. `before` fills the frame, then a divider bar sweeps across (orientation 'horizontal' ↔ or 'vertical' ↕) over totalMs, pushing it aside as `after` is revealed. Good for a literal before/after comparison — not for two unrelated images. Layers land at t=0; call set_layer_time on the returned layerIds (same span, i.e. same endMs-startMs) to move the whole thing elsewhere — every internal keyframe (the sweep, etc.) travels with it.",
    inputSchema: {
      type: "object",
      properties: {
        before: { type: "string", description: "absolute path, shown first" },
        after: { type: "string", description: "absolute path, revealed by the sweep" },
        orientation: { type: "string", enum: ["horizontal", "vertical"] },
        totalMs: { type: "integer", description: "total length, e.g. 4000 (min 1500)" },
      },
      required: ["before", "after", "totalMs"],
      additionalProperties: false,
    },
    handler: async (a, ctx) => {
      const before = str(a.before), after = str(a.after);
      if (!before || !after) return err("before and after must both be absolute file paths");
      const priorIds = new Set(ctx.project().layers.map((l) => l.id));
      const p = await createBeforeAfter(before, after, a.orientation === "vertical" ? "vertical" : "horizontal", int(a.totalMs, 4000));
      await ctx.commit(p);
      const layerIds = p.layers.map((l) => l.id).filter((id) => !priorIds.has(id));
      return ok(JSON.stringify({ layerIds }));
    },
  },
  {
    name: "create_carousel_video",
    description: "Template: spin `images` (each shown once, in order) around a 3D cylinder carousel over totalMs, with an optional caption per image that fades in/out while it faces the camera. Needs at least 2 images. Layers land at t=0; call set_layer_time on the returned layerIds (same span) to move the whole thing elsewhere.",
    inputSchema: {
      type: "object",
      properties: {
        images: { type: "array", items: { type: "string" }, minItems: 2, description: "absolute paths" },
        captions: { type: "array", items: { type: "string" }, description: "one per image, in the same order (optional)" },
        totalMs: { type: "integer", description: "total length across every image" },
      },
      required: ["images", "totalMs"],
      additionalProperties: false,
    },
    handler: async (a, ctx) => {
      const images = Array.isArray(a.images) ? a.images.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
      if (images.length < 2) return err("images must have at least 2 absolute file paths");
      const captions = Array.isArray(a.captions) ? a.captions.filter((x): x is string => typeof x === "string") : [];
      const priorIds = new Set(ctx.project().layers.map((l) => l.id));
      const p = await createCarouselVideo(images, captions, int(a.totalMs, images.length * 2000));
      await ctx.commit(p);
      const layerIds = p.layers.map((l) => l.id).filter((id) => !priorIds.has(id));
      return ok(JSON.stringify({ layerIds }));
    },
  },
  {
    name: "list_styles",
    description: "List the named style packs — complete looks (Instagram Block, News Studio, Traveller's Choice, Luxury Gold, …) with a description of how each looks and when to use it, plus its shot pace. Pick the pack whose description best fits the scenario, cut the timeline at that pace, then call apply_style.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () =>
      ok(JSON.stringify(STYLE_PACKS.map((p) => ({ id: p.id, name: p.name, category: p.category, description: p.description, shotMs: p.shotMs })))),
  },
  {
    name: "apply_style",
    description: "Apply a style pack to the WHOLE timeline in one call: a transition on every cut, a color grade (plus hero-shot accents), Ken Burns motion on every clip, whole-video overlays (grain, vignette, shimmer…), and every text layer restyled (font, size, color, stroke/glow/shadow, animation, color block or lower-third bar). Call it AFTER placing clips and titles; it replaces hand-picked transitions/effects. Re-applying swaps the look. A checkpoint named 'before-style' is saved first.",
    inputSchema: {
      type: "object",
      properties: { style: { type: "string", enum: STYLE_PACKS.map((p) => p.id) } },
      required: ["style"],
      additionalProperties: false,
    },
    handler: async (a, ctx) => {
      const pack = stylePackById(str(a.style));
      if (!pack) return err(`unknown style '${str(a.style)}' — call list_styles for valid ids`);
      await ctx.checkpoint("before-style");
      return ok(JSON.stringify(await applyStylePack(pack, ctx)));
    },
  },
  {
    name: "import_media",
    description: "Import media files (absolute paths: images, videos, audio) into the app's media bin so add_media_layer can place them. Returns the refreshed media list with indices.",
    inputSchema: {
      type: "object",
      properties: { paths: { type: "array", items: { type: "string" }, minItems: 1 } },
      required: ["paths"],
      additionalProperties: false,
    },
    handler: async (a, ctx) => {
      const paths = Array.isArray(a.paths) ? a.paths.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
      if (!paths.length) return err("paths must be a non-empty array of absolute file paths");
      await ctx.importMedia(paths);
      return ok(JSON.stringify(ctx.media.map((m, i) => ({ index: i, kind: m.kind, name: m.path.split(/[\\/]/).pop() }))));
    },
  },
  {
    name: "history",
    description: "Safety net. checkpoint: save a named restore point of the whole project. restore: roll the project back to a named checkpoint. undo / redo: step the engine's edit history by one change. Checkpoint before risky or experimental edits.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["checkpoint", "restore", "undo", "redo"] },
        name: { type: "string", description: "checkpoint name for checkpoint / restore (default 'default')" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    handler: async (a, ctx) => {
      const action = str(a.action);
      const name = str(a.name, "default").replace(/[^\w.-]+/g, "_") || "default";
      if (action === "checkpoint") return ok(JSON.stringify({ checkpoint: name, path: await ctx.checkpoint(name) }));
      if (action === "restore") return (await ctx.restore(name)) ? ok(`restored checkpoint '${name}'`) : err(`no checkpoint named '${name}' — create one with action 'checkpoint' first`);
      if (action === "undo") return (await ctx.undo()) ? ok("undone") : err("nothing to undo");
      if (action === "redo") return (await ctx.redo()) ? ok("redone") : err("nothing to redo");
      return err(`unknown action '${action}' — use checkpoint, restore, undo or redo`);
    },
  },
  // Dev only (roadmap §6/§5's "Dev only" tool family) — meant for Claude Code
  // over the MCP bridge, not the in-app Scenario→Video agent (nothing in its
  // system prompt ever tells it to call this). Gated on the same opt-in flag
  // that turns the bridge on (sefx.mcpBridge) rather than Vite's build-time DEV
  // flag: that flag is baked in at build time and would be false in every
  // installed build, including the one this gets tested against — whoever's
  // turned the bridge on is exactly the "dev" this is for.
  ...(typeof localStorage !== "undefined" && localStorage.getItem("sefx.mcpBridge") === "1"
    ? [
        {
          name: "make_synthetic_reference",
          description: "DEV ONLY. Build a random project through the engine's own API (background shots: Ken Burns motion, transitions, fades, a grade, occasional vignette/grain — no floating elements or text yet), export it, and write the project itself as <name>.truth.json beside <name>.mp4 — a reference whose exact answer is known, for scoring Gate A's aligner (or anything downstream) against. Runs audit_export on the export before returning; a non-zero suspect count means don't count this reference until investigated. REPLACES the current project (checkpoints it first as 'before-synthetic-ref' and restores it after, success or failure) — never call this on a project you want to keep.",
          inputSchema: {
            type: "object",
            properties: {
              photosDir: { type: "string", description: "folder of real photos to draw shots from — needs texture, not flat colour" },
              seed: { type: "integer", description: "deterministic — same seed + same photosDir reproduces the same reference" },
              outDir: { type: "string", description: "folder to write <name>.mp4 + <name>.truth.json into" },
              shots: { type: "integer", description: "default 6" },
              name: { type: "string", description: "base filename, no extension; default synthetic-<seed>" },
              width: { type: "integer", description: "default 1080" },
              height: { type: "integer", description: "default 1920" },
              fps: { type: "number", description: "default 30" },
            },
            required: ["photosDir", "outDir", "seed"],
            additionalProperties: false,
          },
          handler: async (a: Record<string, unknown>, ctx: AgentCtx) => {
            const photosDir = str(a.photosDir);
            const outDir = str(a.outDir);
            if (!photosDir || !outDir) return err("photosDir and outDir are required");
            await ctx.checkpoint("before-synthetic-ref");
            try {
              const result = await makeSyntheticReference(
                {
                  photosDir,
                  outDir,
                  seed: int(a.seed),
                  shots: typeof a.shots === "number" ? int(a.shots) : undefined,
                  name: typeof a.name === "string" ? a.name : undefined,
                  width: typeof a.width === "number" ? int(a.width) : undefined,
                  height: typeof a.height === "number" ? int(a.height) : undefined,
                  fps: typeof a.fps === "number" ? num(a.fps) : undefined,
                },
                ctx
              );
              const audit = await auditExport(result.videoPath, false).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
              return ok(JSON.stringify({
                videoPath: result.videoPath,
                truthPath: result.truthPath,
                shots: result.shots,
                audit: "suspects" in audit ? { totalFrames: audit.totalFrames, suspects: audit.suspects.length } : audit,
              }));
            } catch (e) {
              return err(`make_synthetic_reference failed: ${e instanceof Error ? e.message : String(e)}`);
            } finally {
              await ctx.restore("before-synthetic-ref");
            }
          },
        },
        {
          name: "align_reference",
          description: "DEV ONLY (Gate A spike). Align every sampled frame in [startMs,endMs] of an exported video against the frame at refMs (default startMs), via pyramidal inverse-compositional Lucas-Kanade — the actual inverse-rendering step. Returns, per sampled time, the similarity transform RELATIVE TO the reference frame in analysis-pixel units (256px short side): scale (1.0 = same as reference), rotationDeg, tx/ty, and solved (false = couldn't converge there — too little texture/overlap; carried over from its nearest neighbour, don't trust it). Does not touch the project — reads a video file directly.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "absolute path to the exported video" },
              startMs: { type: "integer" },
              endMs: { type: "integer" },
              refMs: { type: "integer", description: "default startMs" },
              sampleEveryMs: { type: "integer", description: "default 250" },
            },
            required: ["path", "startMs", "endMs"],
            additionalProperties: false,
          },
          handler: async (a: Record<string, unknown>) => {
            const path = str(a.path);
            if (!path) return err("path is required");
            try {
              const samples = await alignReference(
                path,
                int(a.startMs),
                int(a.endMs),
                typeof a.refMs === "number" ? int(a.refMs) : undefined,
                typeof a.sampleEveryMs === "number" ? int(a.sampleEveryMs) : undefined
              );
              return ok(JSON.stringify(samples));
            } catch (e) {
              return err(`align_reference failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          },
        },
        {
          name: "fit_background",
          description: "DEV ONLY (2.5). Key down align_reference's dense per-frame samples into a small set of keyframes with easing (Linear/EaseIn/EaseOut/EaseInOut/Hold/Bezier — an overshoot 'ease out back' is possible), one list per channel (scale/rotationDeg/tx/ty), all sharing the same key TIMES (how an editor keys a whole transform at once). Values stay in align_reference's relative, analysis-pixel space — not yet this engine's absolute comp-space transform.",
          inputSchema: {
            type: "object",
            properties: {
              samples: { type: "array", description: "the array align_reference returned" },
              startMs: { type: "integer", description: "the shot/element span's start — the fit always keys exactly here, not just the nearest sample" },
              endMs: { type: "integer", description: "the shot/element span's end" },
            },
            required: ["samples", "startMs", "endMs"],
            additionalProperties: false,
          },
          handler: async (a: Record<string, unknown>) => {
            if (!Array.isArray(a.samples)) return err("samples is required (the array align_reference returned)");
            try {
              const fitted = await fitBackground(a.samples as Parameters<typeof fitBackground>[0], int(a.startMs), int(a.endMs));
              return ok(JSON.stringify(fitted));
            } catch (e) {
              return err(`fit_background failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          },
        },
        {
          name: "detect_cuts",
          description: "DEV ONLY (inverse rendering). Find shot/cut boundaries in a video via frame-difference peaks — kind 'hard' (instant jump) or 'soft' (a wider elevated window — a crossfade/wipe/etc), with a rough span in ms. This is the first step of inverse-rendering an existing edit: run this first to get shot boundaries, then align_reference per shot for its motion. Calibrated on synthetic ground truth, not guaranteed on arbitrary real footage — cross-check a few boundaries by eye (extract_frames-equivalent / render_preview) before trusting it blindly.",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string", description: "absolute path to the video" } },
            required: ["path"],
            additionalProperties: false,
          },
          handler: async (a: Record<string, unknown>) => {
            const path = str(a.path);
            if (!path) return err("path is required");
            try {
              return ok(JSON.stringify(await detectCuts(path)));
            } catch (e) {
              return err(`detect_cuts failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          },
        },
        {
          name: "analyze_reference",
          description: "DEV ONLY (inverse rendering). The actual measurement step: cuts (detect_cuts), and per resulting shot — look/grade (brightness/contrast/saturate/vignetteStrength, both as effect-ready multipliers), fadeInMs/fadeOutMs, candidate text/graphic overlay regions (textRegions: where + roughly when, NOT what — no OCR), and, when the shot has enough duration/texture, recovered relative camera motion (motion + isStill — isStill is a cheap proxy: did most sampled frames converge, not a real still-vs-footage classifier). Does NOT match transitions (call match_transition per boundary) or read text content (read the frames yourself) or rebuild anything (call rebuild_from_analysis once you've assembled a full analysis object). Call this first.",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string", description: "absolute path to the reference video" } },
            required: ["path"],
            additionalProperties: false,
          },
          handler: async (a: Record<string, unknown>) => {
            const path = str(a.path);
            if (!path) return err("path is required");
            try {
              return ok(JSON.stringify(await analyzeReference(path)));
            } catch (e) {
              return err(`analyze_reference failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          },
        },
        {
          name: "generate_phrasings",
          description: "DEV ONLY (template decomposition). Submits one shot's distinct trackable element TYPES (typically photo/image cards, logos) and 2-3 varied SAM3-matchable phrasings per type, which YOU determine by looking at that shot's own key-frame images yourself first (read them directly - this tool does not read images or call any model, it only persists what you give it). Always include one plain literal noun per type; never use the bare word 'card' alone, SAM3 reliably fails to match it even on an obvious card. Merges into the phrasings.json-shaped file at outPath ({[shotName]: [{type, phrasings}]} — sam/phase3_core.py's own input shape), replacing any prior entry for this shot, plus an audit-trail line in extraction_submissions.jsonl.",
          inputSchema: {
            type: "object",
            properties: {
              shotName: { type: "string" },
              elementTypes: {
                type: "array",
                items: {
                  type: "object",
                  properties: { type: { type: "string" }, phrasings: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 3 } },
                  required: ["type", "phrasings"],
                },
                description: "empty array if this shot has no trackable image/logo elements - don't invent one to avoid an empty answer",
              },
              outPath: { type: "string", description: "absolute path to the phrasings.json-shaped file to merge into (created if missing)" },
            },
            required: ["shotName", "elementTypes", "outPath"],
            additionalProperties: false,
          },
          handler: async (a: Record<string, unknown>) => {
            const shotName = str(a.shotName);
            const outPath = str(a.outPath);
            if (!shotName) return err("shotName is required");
            if (!outPath) return err("outPath is required");
            if (!Array.isArray(a.elementTypes)) return err("elementTypes must be an array (can be empty)");
            try {
              await submitPhrasings(outPath, shotName, a.elementTypes as ElementTypePhrasing[]);
              return ok(JSON.stringify({ shotName, elementTypeCount: a.elementTypes.length, outPath }));
            } catch (e) {
              return err(`generate_phrasings failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          },
        },
        {
          name: "read_text_lines",
          description: "DEV ONLY (template decomposition). Submits one key frame's visible text lines, which YOU determine by looking at that exact frame yourself first (read it directly - this tool does not read images or call any model, it only persists what you give it): a tight fractional [x0,y0,x1,y1] box per line, the exact content as currently visible (not guessed-ahead for a mid-reveal word), and a role (headline/label/logo wordmark/other). Call once per key frame, not once per shot — content changes frame to frame for a kinetic reveal. Merges into the text_lines.json-shaped file at outPath ({[shotName]: [{idx,box,content,role}]} — sam/phase3_core.py's own input shape), replacing any prior lines already submitted for this exact frameIdx, plus an audit-trail line.",
          inputSchema: {
            type: "object",
            properties: {
              shotName: { type: "string" },
              frameIdx: { type: "integer", description: "this key frame's own index within the shot" },
              textLines: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    box: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
                    content: { type: "string" },
                    role: { type: "string", enum: ["headline", "label", "logo wordmark", "other"] },
                  },
                  required: ["box", "content", "role"],
                },
                description: "empty array if no text is visible in this frame",
              },
              outPath: { type: "string", description: "absolute path to the text_lines.json-shaped file to merge into (created if missing)" },
            },
            required: ["shotName", "frameIdx", "textLines", "outPath"],
            additionalProperties: false,
          },
          handler: async (a: Record<string, unknown>) => {
            const shotName = str(a.shotName);
            const outPath = str(a.outPath);
            if (!shotName) return err("shotName is required");
            if (!outPath) return err("outPath is required");
            if (typeof a.frameIdx !== "number") return err("frameIdx is required");
            if (!Array.isArray(a.textLines)) return err("textLines must be an array (can be empty)");
            try {
              await submitTextLines(outPath, shotName, int(a.frameIdx), a.textLines as TextLineReading[]);
              return ok(JSON.stringify({ shotName, frameIdx: a.frameIdx, textLineCount: a.textLines.length, outPath }));
            } catch (e) {
              return err(`read_text_lines failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          },
        },
        {
          name: "match_transition",
          description: "DEV ONLY (inverse rendering). Given one real transition boundary in a reference video (a cut from analyze_reference, or detect_cuts), find which of the ~25 registry transition engines it most resembles: renders every candidate at a few progress points across the window using real beforeMs/afterMs reference frames as clip A/B, compares each against the REAL observed frames at those same points (SSIM-based, 0..1), and returns the top matches ranked best-first. beforeMs should be a clean frame well before the cut starts blending, afterMs a clean frame well after it settles; windowStartMs/windowEndMs bound the actual blend. A returned score near 1.0 is a confident match; scores clustered and mediocre (well under ~0.7) mean nothing matched well — a plain cut or an untracked custom look is more honest than forcing a weak match.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "absolute path to the reference video" },
              beforeMs: { type: "integer" },
              afterMs: { type: "integer" },
              windowStartMs: { type: "integer" },
              windowEndMs: { type: "integer" },
              sampleCount: { type: "integer", description: "default 4" },
              topN: { type: "integer", description: "default 3" },
            },
            required: ["path", "beforeMs", "afterMs", "windowStartMs", "windowEndMs"],
            additionalProperties: false,
          },
          handler: async (a: Record<string, unknown>) => {
            const path = str(a.path);
            if (!path) return err("path is required");
            try {
              const ranked = await matchTransition(path, {
                beforeMs: int(a.beforeMs),
                afterMs: int(a.afterMs),
                windowStartMs: int(a.windowStartMs),
                windowEndMs: int(a.windowEndMs),
                sampleCount: typeof a.sampleCount === "number" ? int(a.sampleCount) : undefined,
                topN: typeof a.topN === "number" ? int(a.topN) : undefined,
              });
              return ok(JSON.stringify(ranked));
            } catch (e) {
              return err(`match_transition failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          },
        },
        {
          name: "rebuild_from_analysis",
          description: "DEV ONLY (inverse rendering). The actual replay step: given a full analysis object (durationMs/width/height/fps, shots[] with startMs/endMs/isStill/motion/look, transitions[] with atMs/engine/durMs — from match_transition, textBeats[] with startMs/endMs/content — content you supply, no OCR happens here) and a list of new media paths (one per shot in order; cycles if there are fewer images than shots), builds a BRAND NEW project replaying the measured structure with the new media and exports it. REPLACES the current project — checkpoints it first as 'before-rebuild-from-analysis' and restores it after, success or failure, so the rebuilt project itself is gone once this returns UNLESS `savePath` is given, in which case it's also saved to that .sefx file (pretty JSON) before the restore, so you can open it later without disturbing whatever project was live when you called this. This is where analyze_reference's raw output, your own match_transition calls, and your own read of the reference's on-screen text all get assembled together — this tool doesn't do that assembly, you do, then hand it the finished object.",
          inputSchema: {
            type: "object",
            properties: {
              analysis: { type: "object", description: "a TemplateAnalysis object: {durationMs,width,height,fps,shots[],transitions[],textBeats[]} — see the tool description" },
              newMedia: { type: "array", items: { type: "string" }, minItems: 1, description: "absolute image paths, one per shot (cycles if shorter)" },
              outPath: { type: "string", description: "absolute path to write the rebuilt .mp4 to" },
              savePath: { type: "string", description: "optional absolute path to also save the rebuilt PROJECT (.sefx) to, before it's restored away - omit to leave no saved project file, matching the tool's older behaviour" },
            },
            required: ["analysis", "newMedia", "outPath"],
            additionalProperties: false,
          },
          handler: async (a: Record<string, unknown>, ctx: AgentCtx) => {
            const newMedia = Array.isArray(a.newMedia) ? a.newMedia.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
            const outPath = str(a.outPath);
            const savePath = typeof a.savePath === "string" && a.savePath.length > 0 ? a.savePath : undefined;
            if (!a.analysis || typeof a.analysis !== "object") return err("analysis (object) is required");
            if (!newMedia.length) return err("newMedia must be a non-empty array of absolute image paths");
            if (!outPath) return err("outPath is required");
            await ctx.checkpoint("before-rebuild-from-analysis");
            try {
              const result = await rebuildFromAnalysis(a.analysis as RebuildTemplateAnalysis, newMedia, ctx, outPath);
              if (savePath) await saveProjectFile(savePath);
              const audit = await auditExport(result.videoPath, false).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
              return ok(JSON.stringify({
                videoPath: result.videoPath,
                projectPath: savePath ?? null,
                shots: (a.analysis as RebuildTemplateAnalysis).shots.length,
                audit: "suspects" in audit ? { totalFrames: audit.totalFrames, suspects: audit.suspects.length } : audit,
              }));
            } catch (e) {
              return err(`rebuild_from_analysis failed: ${e instanceof Error ? e.message : String(e)}`);
            } finally {
              await ctx.restore("before-rebuild-from-analysis");
            }
          },
        },
        {
          name: "open_project_file",
          description: "DEV ONLY. Open a .sefx project file by absolute path, REPLACING the currently live project (no checkpoint/restore - unlike rebuild_from_analysis, this is a permanent swap). Use render_preview/contact_sheet right after to inspect what actually loaded.",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string", description: "absolute path to a .sefx file" } },
            required: ["path"],
            additionalProperties: false,
          },
          handler: async (a: Record<string, unknown>, ctx: AgentCtx) => {
            const path = str(a.path);
            if (!path) return err("path is required");
            try {
              const p = await openProjectFile(path);
              await ctx.commit(p);
              return ok(JSON.stringify({ layers: p.layers.length, durationMs: p.durationMs, width: p.width, height: p.height }));
            } catch (e) {
              return err(`open_project_file failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          },
        },
        {
          name: "start_sam_service",
          description: "DEV ONLY (template decomposition, roadmap item 2). Starts sam/sam_service.py (SAM3 concept detection + SAM2 bidirectional tracking + mask-shape fit, as a persistent localhost HTTP service — model loading alone costs ~7s, so it's started once and reused). Blocks until the service answers its own /health endpoint or 60s elapses, so a successful return means segment_concepts/refine_element are ready to call immediately. Safe to call again if already running (no-op). Default port 8799 — pass the same port to segment_concepts/refine_element if overridden here.",
          inputSchema: {
            type: "object",
            properties: {
              pythonPath: { type: "string", description: "absolute path to the venv's python.exe, e.g. .../sam/.venv/Scripts/python.exe" },
              scriptPath: { type: "string", description: "absolute path to sam/sam_service.py" },
              port: { type: "integer", description: "default 8799" },
            },
            required: ["pythonPath", "scriptPath"],
            additionalProperties: false,
          },
          handler: async (a: Record<string, unknown>) => {
            const pythonPath = str(a.pythonPath);
            const scriptPath = str(a.scriptPath);
            if (!pythonPath) return err("pythonPath is required");
            if (!scriptPath) return err("scriptPath is required");
            const port = int(a.port, 8799);
            try {
              await startSamService(pythonPath, scriptPath, port);
              const deadline = Date.now() + 60_000;
              while (Date.now() < deadline) {
                try {
                  const res = await fetch(`http://127.0.0.1:${port}/health`);
                  if (res.ok) return ok(JSON.stringify({ port, status: "ready" }));
                } catch {
                  // not listening yet - keep polling
                }
                await new Promise((r) => setTimeout(r, 500));
              }
              return err(`sam_service did not become healthy on port ${port} within 60s — check it's still running (sam_service_status) and the paths are correct`);
            } catch (e) {
              return err(`start_sam_service failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          },
        },
        {
          name: "sam_service_status",
          description: "DEV ONLY (template decomposition, roadmap item 2). Whether a spawned sam_service process is still alive (NOT whether it's finished loading models — a freshly-spawned process answers true here immediately but won't answer /health, and therefore segment_concepts/refine_element, until model loading finishes).",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          handler: async () => {
            try {
              return ok(JSON.stringify({ running: await samServiceStatus() }));
            } catch (e) {
              return err(`sam_service_status failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          },
        },
        {
          name: "stop_sam_service",
          description: "DEV ONLY (template decomposition, roadmap item 2). Kill the running sam_service process, if any (releases its GPU memory). No-op if nothing is running.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          handler: async () => {
            try {
              await stopSamService();
              return ok(JSON.stringify({ stopped: true }));
            } catch (e) {
              return err(`stop_sam_service failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          },
        },
        {
          name: "segment_concepts",
          description: "DEV ONLY (template decomposition, roadmap item 2). SAM3 image-mode concept detection at one frame: given an image path and a list of text phrasings, returns the boxes SAM3 matched, deduped by box IoU within this one frame. Same detection this tool's own sam/phase3_core.py already does — now callable live from the app instead of a separate dev-session script. Requires start_sam_service to have succeeded first.",
          inputSchema: {
            type: "object",
            properties: {
              imagePath: { type: "string", description: "absolute path to the frame image" },
              concepts: { type: "array", items: { type: "string" }, minItems: 1 },
              port: { type: "integer", description: "default 8799 — must match start_sam_service's own port" },
            },
            required: ["imagePath", "concepts"],
            additionalProperties: false,
          },
          handler: async (a: Record<string, unknown>) => {
            const imagePath = str(a.imagePath);
            if (!imagePath) return err("imagePath is required");
            if (!Array.isArray(a.concepts) || !a.concepts.length) return err("concepts must be a non-empty array");
            const port = int(a.port, 8799);
            try {
              const res = await fetch(`http://127.0.0.1:${port}/segment_concepts`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ imagePath, concepts: a.concepts }),
              });
              const body = await res.json();
              if (!res.ok) return err(`segment_concepts failed: ${body.error ?? res.statusText}`);
              return ok(JSON.stringify(body));
            } catch (e) {
              return err(`segment_concepts failed: ${e instanceof Error ? e.message : String(e)} — is start_sam_service running?`);
            }
          },
        },
        {
          name: "refine_element",
          description: "DEV ONLY (template decomposition, roadmap item 2). Bidirectional SAM2 tracking of one element from its own seed box/frame across a whole shot clip, then fit_elements.py's own mask-shape motion fit. Returns refBbox/refCentroid (the reference frame's own box and exact pivot centroid) and samples (AlignSample[] — RAW per-frame scale/rotationDeg/tx/ty, NOT yet keyed down; pass them to this app's own fit_background tool for that step, same as sam/phase3_core.py already does — this service never calls back into the app itself). refBbox/refCentroid/samples are all null if SAM2 couldn't track anything from that seed. Requires start_sam_service to have succeeded first.",
          inputSchema: {
            type: "object",
            properties: {
              videoPath: { type: "string", description: "absolute path to the shot's own clip" },
              seedFrameIdx: { type: "integer", description: "frame index (within this clip) to seed tracking from" },
              box: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4, description: "[x0,y0,x1,y1] pixel box at seedFrameIdx" },
              port: { type: "integer", description: "default 8799 — must match start_sam_service's own port" },
            },
            required: ["videoPath", "seedFrameIdx", "box"],
            additionalProperties: false,
          },
          handler: async (a: Record<string, unknown>) => {
            const videoPath = str(a.videoPath);
            if (!videoPath) return err("videoPath is required");
            if (typeof a.seedFrameIdx !== "number") return err("seedFrameIdx is required");
            if (!Array.isArray(a.box) || a.box.length !== 4) return err("box must be a 4-element array");
            const port = int(a.port, 8799);
            try {
              const res = await fetch(`http://127.0.0.1:${port}/refine_element`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ videoPath, seedFrameIdx: int(a.seedFrameIdx), box: a.box }),
              });
              const body = await res.json();
              if (!res.ok) return err(`refine_element failed: ${body.error ?? res.statusText}`);
              return ok(JSON.stringify(body));
            } catch (e) {
              return err(`refine_element failed: ${e instanceof Error ? e.message : String(e)} — is start_sam_service running?`);
            }
          },
        },
      ]
    : []),
];

export const toolByName = new Map(TOOLS.map((t) => [t.name, t]));
