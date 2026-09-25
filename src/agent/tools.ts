// The agent's tool registry: MCP-shaped entries (name, description, JSON-Schema
// inputSchema, handler) that are thin, validated adapters over the existing
// editing engine (src/lib/api.ts). The same registry feeds the in-app Claude
// loop today and can be re-exposed over MCP later without touching handlers.
//
// Scope is deliberately the "watchable scenario video" 80%: arrange, trim,
// transition, speed, text, basic colour, music. No LUT / chroma / stabilize /
// denoise / duck — those capabilities don't exist in the engine yet.
import type { Project } from "../bindings/Project";
import { REGISTRY } from "../lib/transitions/registry";
import {
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
  /** Composite one frame at `tMs`; resolves to a PNG data URL. */
  renderPreview(tMs: number): Promise<string>;
  log(text: string): void;
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
    description: "Composite and return the frame at tMs as an image so you can visually check the edit. Use it to verify pacing/framing before finishing. Cheap to call a few times; don't spam it.",
    inputSchema: {
      type: "object",
      properties: { tMs: { type: "integer" } },
      required: ["tMs"],
      additionalProperties: false,
    },
    handler: async (a, ctx) => {
      try {
        const url = await ctx.renderPreview(int(a.tMs));
        return { image: url };
      } catch (e) {
        return err(`render failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  },
];

export const toolByName = new Map(TOOLS.map((t) => [t.name, t]));
