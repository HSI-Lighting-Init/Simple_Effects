// Scenario -> video loop. Provider-agnostic: keeps a neutral turn history, asks
// the chosen provider for the next turn, dispatches its tool calls to the engine,
// feeds results back, until the model stops calling tools.
import { toolByName, TOOLS, type AgentCtx, type ToolResult } from "./tools";
import { EDITOR_SYSTEM_PROMPT } from "./systemPrompt";
import { makeProvider, type AgentTurn, type ProviderId } from "./providers";

const READONLY = new Set(["get_timeline", "list_media", "list_effects", "list_transitions", "validate_timeline", "render_preview"]);

export interface RunOpts {
  provider: ProviderId;
  apiKey: string;
  model: string;
  scenario: string;
  targetSec: number;
  style: string;
  dryRun: boolean;
  maxCalls?: number;
  signal?: AbortSignal;
  onLog: (text: string) => void;
}

function describe(name: string, args: Record<string, unknown>, r: ToolResult): string {
  if (r.isError) return `⚠ ${name}: ${r.text}`;
  switch (name) {
    case "add_media_layer": return `Placed asset #${args.mediaIndex}. ${r.text}`;
    case "add_text": return `Added text "${String(args.text).slice(0, 30)}"`;
    case "set_layer_time": return `Set layer ${args.layerId} to ${args.startMs}–${args.endMs}ms`;
    case "split_layer": return `Split layer ${args.layerId} at ${args.tMs}ms`;
    case "delete_layer": return `Deleted layer ${args.layerId}`;
    case "set_transition": return `${args.slot} transition '${args.engine}' on layer ${args.layerId}`;
    case "set_speed": return `Layer ${args.layerId} speed ×${args.speed}`;
    case "apply_color": return `Applied ${args.kind} to layer ${args.layerId}`;
    case "set_audio": return `Adjusted audio on layer ${args.layerId}`;
    case "render_preview": return `Rendered preview @ ${args.tMs}ms`;
    case "validate_timeline": return `Checked timeline`;
    default: return name; // discovery calls stay quiet-ish
  }
}

/** Run the scenario→edit loop. Resolves with the model's closing summary. */
export async function runAgent(ctx: AgentCtx, opts: RunOpts): Promise<{ summary: string }> {
  const maxCalls = opts.maxCalls ?? 60;
  const provider = makeProvider(opts.provider, opts.apiKey, opts.model);
  const mediaList = ctx.media.map((m, i) => `#${i} ${m.kind} ${m.path.split(/[\\/]/).pop()} (${Math.round(m.durationMs)}ms)`).join("\n");
  const history: AgentTurn[] = [
    {
      role: "user",
      text:
        `Scenario:\n${opts.scenario}\n\nTarget duration: ~${opts.targetSec}s. Style: ${opts.style || "clean"}.\n\n` +
        `Selected assets:\n${mediaList || "(none)"}\n\n` +
        (opts.dryRun ? "DRY RUN: plan only, do not change anything.\n" : "") +
        `Plan the shots first, then build the timeline with tools, verify, and finish.`,
    },
  ];

  let calls = 0;
  let summary = "";
  while (calls < maxCalls) {
    if (opts.signal?.aborted) throw new Error("cancelled");
    const reply = await provider.chat(EDITOR_SYSTEM_PROMPT, history, TOOLS, opts.signal);
    history.push({ role: "assistant", text: reply.text, toolCalls: reply.toolCalls });
    if (reply.text) summary = reply.text;

    if (reply.toolCalls.length === 0) break; // model is done / summarised

    const results: { id: string; result: ToolResult }[] = [];
    for (const call of reply.toolCalls) {
      if (opts.signal?.aborted) throw new Error("cancelled");
      calls++;
      const tool = toolByName.get(call.name);
      let result: ToolResult;
      if (!tool) result = { text: `unknown tool ${call.name}`, isError: true };
      else if (opts.dryRun && !READONLY.has(call.name)) result = { text: "(dry run — not applied)" };
      else {
        try {
          result = await tool.handler(call.input ?? {}, ctx);
        } catch (e) {
          result = { text: `tool error: ${e instanceof Error ? e.message : String(e)}`, isError: true };
        }
      }
      opts.onLog(describe(call.name, call.input ?? {}, result));
      results.push({ id: call.id, result });
    }
    history.push({ role: "tool", results });
  }
  if (calls >= maxCalls) opts.onLog(`Reached the ${maxCalls}-call limit — stopping with a partial result.`);
  return { summary: summary || "Done." };
}
