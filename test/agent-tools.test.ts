import { describe, it, expect } from "vitest";
import { toolByName, TOOLS, type AgentCtx } from "../src/agent/tools";
import { mcpToolsList } from "../src/agent/mcpManifest";
import type { Project } from "../src/bindings/Project";

// A tiny project + ctx; only the read/validation paths are exercised (they return
// before any api.ts/Tauri call), so no backend mock is needed.
const project = (): Project =>
  ({
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 4000,
    media: [],
    layers: [
      {
        id: 1,
        name: "pic",
        startMs: 0,
        endMs: 2000,
        hidden: false,
        attach: null,
        effects: [],
        transitionIn: null,
        transitionOut: null,
        transform: {} as never,
        kind: { kind: "image", src: "a.png", width: 10, height: 10, crop: null },
      } as never,
    ],
  }) as Project;

const ctx = (p = project()): AgentCtx => ({
  media: [{ path: "x.png", kind: "image", durationMs: 0, width: 10, height: 10 }],
  project: () => p,
  commit: async () => {},
  addMedia: async () => 99,
  renderPreview: async () => "",
  log: () => {},
});

const call = (name: string, args: Record<string, unknown>, c = ctx()) => toolByName.get(name)!.handler(args, c);

describe("agent tool boundary", () => {
  it("get_timeline reports the layer", async () => {
    expect(JSON.parse((await call("get_timeline", {})).text!).layers[0].id).toBe(1);
  });

  it("list_effects / list_transitions return non-empty catalogs", async () => {
    expect(JSON.parse((await call("list_effects", {})).text!).length).toBeGreaterThan(0);
    expect(JSON.parse((await call("list_transitions", {})).text!).length).toBeGreaterThan(0);
  });

  it("errors (not raw throws) on a missing layer", async () => {
    const r = await call("set_layer_time", { layerId: 42, startMs: 0, endMs: 1000 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not found/);
  });

  it("rejects an unknown colour effect and out-of-range media index", async () => {
    expect((await call("apply_color", { layerId: 1, kind: "teleport", amount: 1 })).isError).toBe(true);
    expect((await call("add_media_layer", { mediaIndex: 7 })).isError).toBe(true);
  });

  it("rejects speed on a non-clip layer", async () => {
    expect((await call("set_speed", { layerId: 1, speed: 2 })).isError).toBe(true);
  });

  it("mcp manifest matches the registry (single source of truth)", () => {
    const m = mcpToolsList();
    expect(m.tools.length).toBe(TOOLS.length);
    for (const t of m.tools) expect(t.inputSchema).toBeTruthy();
  });

  it("validate_timeline flags an out-of-range layer", async () => {
    const p = project();
    (p.layers[0] as { endMs: number }).endMs = 99999;
    expect(JSON.parse((await call("validate_timeline", {}, ctx(p))).text!).issues.length).toBeGreaterThan(0);
  });
});
