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
import { REGISTRY } from "../lib/transitions/registry";
import { STYLE_PACKS, stylePackById, applyStylePack } from "../lib/stylePacks";
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

// Basic colour effects the agent is allowed to use, with the param each drives.
const COLOR: Record<string, { param: "amount" | "radius" | "degrees"; lo: number; hi: number; note: string }> = {
  brightness: { param: "amount", lo: 0, hi: 3, note: "1 = unchanged, <1 darker, >1 brighter" },
  contrast: { param: "amount", lo: 0, hi: 3, note: "1 = unchanged" },
  saturate: { param: "amount", lo: 0, hi: 3, note: "1 = unchanged, 0 = greyscale" },
  hue: { param: "degrees", lo: -180, hi: 180, note: "degrees of hue rotation" },
  blur: { param: "radius", lo: 0, hi: 100, note: "blur radius in px" },
  grayscale: { param: "amount", lo: 0, hi: 1, note: "0..1 amount" },
  invert: { param: "amount", lo: 0, hi: 1, note: "0..1 amount" },
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
    description: "List the colour/blur effects you may apply (name + parameter range). Only these exist — never invent effect names or values.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () =>
      ok(JSON.stringify(Object.entries(COLOR).map(([kind, c]) => ({ kind, param: c.param, min: c.lo, max: c.hi, note: c.note })))),
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
    description: "Set a keyframe on a layer's transform at an exact time — position (x/y), scale (scaleX/scaleY), rotation, or opacity. Only the fields you pass change. Call it at 2+ different times on the same layer to animate a custom move — e.g. a punch-in-then-back-out zoom (normal → zoomed at the midpoint → normal again), instead of apply_style's simple straight-line Ken Burns drift. Get the layer's current scale/position first (fit-to-frame scale = min(compWidth/imageWidth, compHeight/imageHeight)) so your keyframes start from where it already sits, not a jump.",
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
    name: "apply_color",
    description: "Apply one basic colour/blur effect to a layer at a constant amount. kind + amount range come from list_effects.",
    inputSchema: {
      type: "object",
      properties: {
        layerId: { type: "integer" },
        kind: { type: "string", enum: Object.keys(COLOR) },
        amount: { type: "number" },
      },
      required: ["layerId", "kind", "amount"],
      additionalProperties: false,
    },
    handler: async (a, ctx) => {
      const id = int(a.layerId);
      if (!findLayer(ctx.project(), id)) return notFound(id);
      const kind = str(a.kind);
      const c = COLOR[kind];
      if (!c) return err(`unknown effect '${kind}' — call list_effects`);
      const value = Math.max(c.lo, Math.min(c.hi, num(a.amount)));
      let p = await addEffect(id, kind);
      const layer = findLayer(p, id);
      const index = layer ? layer.effects.length - 1 : 0;
      p = await keyEffect(id, index, c.param, 0, value, false);
      await ctx.commit(p);
      return ok(JSON.stringify({ applied: kind, value }));
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
    description: "Check an already-exported video against the CURRENT project's image layers: every 250ms, does the frame actually look like whichever image layer(s) should be visible there (a luminance + colour fingerprint match)? Flags frames whose closest match is a different layer or nothing expected — the signature of the known intermittent content-swap export bug (handoff §11.1). Only image-kind layers are checked (video/text/shapes have no single static source to fingerprint). Run this after every export while that bug is open; it must flag a known-bad export before its result can be trusted on a fix. verbose also returns every frame's numbers (not just flagged ones), for calibrating the match threshold against a known-bad export.",
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
        return ok(JSON.stringify({ ...rest, sheetAvailable: !!sheet }));
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
];

export const toolByName = new Map(TOOLS.map((t) => [t.name, t]));
