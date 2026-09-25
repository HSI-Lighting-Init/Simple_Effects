import { describe, it, expect, vi, afterEach } from "vitest";
import { runAgent } from "../src/agent/orchestrator";
import type { AgentCtx, MediaAsset } from "../src/agent/tools";
import type { Project } from "../src/bindings/Project";

// Drive the REAL loop with a scripted Claude (mocked fetch), against a recording
// ctx. No API key, no Tauri — this exercises the orchestration wiring: dispatch,
// tool_result feedback, dry-run, cancel.

const media: MediaAsset[] = [{ path: "clip.mp4", kind: "video", durationMs: 5000, width: 1920, height: 1080 }];
const project = (): Project => ({ width: 1920, height: 1080, fps: 30, durationMs: 10000, media: [], layers: [] }) as Project;

function recordingCtx() {
  const calls: string[] = [];
  const ctx: AgentCtx = {
    media,
    project,
    commit: async () => {},
    addMedia: async (i) => {
      calls.push(`addMedia:${i}`);
      return 1;
    },
    renderPreview: async () => "data:image/png;base64,AAAA",
    log: () => {},
  };
  return { ctx, calls };
}

// Queue of scripted Anthropic responses; fetch returns them in order.
function mockClaude(responses: unknown[]) {
  let n = 0;
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    json: async () => responses[Math.min(n++, responses.length - 1)],
    text: async () => "",
  }));
}

afterEach(() => vi.unstubAllGlobals());

const PLAN_THEN_ACT = [
  {
    stop_reason: "tool_use",
    content: [
      { type: "text", text: "Plan: place the clip." },
      { type: "tool_use", id: "t1", name: "list_media", input: {} },
      { type: "tool_use", id: "t2", name: "add_media_layer", input: { mediaIndex: 0 } },
    ],
  },
  { stop_reason: "end_turn", content: [{ type: "text", text: "Built a 5s clip." }] },
];

const opts = (over: Partial<Parameters<typeof runAgent>[1]> = {}) => ({
  provider: "anthropic" as const,
  apiKey: "sk-test",
  model: "claude-test",
  scenario: "one clip",
  targetSec: 5,
  style: "clean",
  dryRun: false,
  onLog: () => {},
  ...over,
});

// DeepSeek returns OpenAI-shaped messages; the loop must parse tool_calls the same.
const DEEPSEEK_PLAN_THEN_ACT = [
  { choices: [{ message: { content: "Plan.", tool_calls: [{ id: "d1", type: "function", function: { name: "add_media_layer", arguments: '{"mediaIndex":0}' } }] } }] },
  { choices: [{ message: { content: "Built it.", tool_calls: [] } }] },
];

describe("agent loop", () => {
  it("dispatches tool calls and returns the closing summary", async () => {
    mockClaude(PLAN_THEN_ACT);
    const { ctx, calls } = recordingCtx();
    const { summary } = await runAgent(ctx, opts());
    expect(calls).toContain("addMedia:0"); // the mutating tool actually ran
    expect(summary).toBe("Built a 5s clip.");
  });

  it("dry run plans without mutating", async () => {
    mockClaude(PLAN_THEN_ACT);
    const { ctx, calls } = recordingCtx();
    await runAgent(ctx, opts({ dryRun: true }));
    expect(calls).not.toContain("addMedia:0"); // mutation skipped
  });

  it("parses DeepSeek (OpenAI-shaped) tool calls too", async () => {
    mockClaude(DEEPSEEK_PLAN_THEN_ACT);
    const { ctx, calls } = recordingCtx();
    const { summary } = await runAgent(ctx, opts({ provider: "deepseek", model: "deepseek-chat" }));
    expect(calls).toContain("addMedia:0");
    expect(summary).toBe("Built it.");
  });

  it("aborts when cancelled", async () => {
    mockClaude(PLAN_THEN_ACT);
    const { ctx } = recordingCtx();
    const ac = new AbortController();
    ac.abort();
    await expect(runAgent(ctx, opts({ signal: ac.signal }))).rejects.toThrow(/cancel/);
  });
});
