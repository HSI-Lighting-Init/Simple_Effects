// Provider adapters behind one interface. The orchestrator speaks a neutral
// turn history; each adapter serialises it to its own API shape and parses the
// reply back. Two real implementations (Claude, DeepSeek) so the interface earns
// its keep. BYO key, direct browser calls (CSP is open).
import type { ToolDef, ToolResult } from "./tools";

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}
// Neutral conversation turns the loop keeps and replays through any provider.
export type AgentTurn =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[] }
  | { role: "tool"; results: { id: string; result: ToolResult }[] };

export interface AssistantReply {
  text: string;
  toolCalls: ToolCall[];
}

export interface AgentProvider {
  /** One model turn: given the history + tools, return text + any tool calls. */
  chat(system: string, history: AgentTurn[], tools: ToolDef[], signal?: AbortSignal): Promise<AssistantReply>;
}

export type ProviderId = "anthropic" | "deepseek";

export const MODELS: Record<ProviderId, { label: string; models: string[] }> = {
  anthropic: { label: "Anthropic (Claude)", models: ["claude-opus-4-1", "claude-sonnet-4-5", "claude-haiku-4-5"] },
  deepseek: { label: "DeepSeek", models: ["deepseek-chat", "deepseek-reasoner"] },
};

// --- Anthropic (native tool use + vision) ---
class AnthropicProvider implements AgentProvider {
  constructor(private apiKey: string, private model: string) {}

  async chat(system: string, history: AgentTurn[], tools: ToolDef[], signal?: AbortSignal): Promise<AssistantReply> {
    const messages = history.map((t) => {
      if (t.role === "user") return { role: "user", content: t.text };
      if (t.role === "assistant") {
        const content: unknown[] = [];
        if (t.text) content.push({ type: "text", text: t.text });
        for (const c of t.toolCalls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
        return { role: "assistant", content };
      }
      return {
        role: "user",
        content: t.results.map(({ id, result }) =>
          result.image
            ? { type: "tool_result", tool_use_id: id, content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: result.image.replace(/^data:image\/\w+;base64,/, "") } }] }
            : { type: "tool_result", tool_use_id: id, content: result.text ?? "ok", is_error: result.isError }
        ),
      };
    });
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
      body: JSON.stringify({ model: this.model, max_tokens: 4096, system, tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })), messages }),
      signal,
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    const data = (await res.json()) as { content: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[] };
    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const b of data.content) {
      if (b.type === "text" && b.text) text += b.text;
      else if (b.type === "tool_use") toolCalls.push({ id: b.id!, name: b.name!, input: b.input ?? {} });
    }
    return { text: text.trim(), toolCalls };
  }
}

// --- DeepSeek (OpenAI-compatible, text-only: previews go back as a note) ---
class DeepSeekProvider implements AgentProvider {
  constructor(private apiKey: string, private model: string) {}

  async chat(system: string, history: AgentTurn[], tools: ToolDef[], signal?: AbortSignal): Promise<AssistantReply> {
    const messages: unknown[] = [{ role: "system", content: system }];
    for (const t of history) {
      if (t.role === "user") messages.push({ role: "user", content: t.text });
      else if (t.role === "assistant")
        messages.push({
          role: "assistant",
          content: t.text || null,
          tool_calls: t.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } })),
        });
      else
        for (const { id, result } of t.results)
          messages.push({ role: "tool", tool_call_id: id, content: result.image ? "[preview rendered; image not shown to this text-only model — judge by the timeline metadata]" : result.text ?? "ok" });
    }
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, max_tokens: 4096, messages, tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })) }),
      signal,
    });
    if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    const data = (await res.json()) as { choices: { message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[] };
    const msg = data.choices?.[0]?.message ?? { content: "", tool_calls: [] };
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c) => {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(c.function.arguments || "{}");
      } catch {
        // Malformed args: leave empty so the handler returns an actionable error
        // the model can correct on the next turn (cheaper than a retry dance).
        input = {};
      }
      return { id: c.id, name: c.function.name, input };
    });
    return { text: (msg.content ?? "").trim(), toolCalls };
  }
}

export function makeProvider(id: ProviderId, apiKey: string, model: string): AgentProvider {
  return id === "deepseek" ? new DeepSeekProvider(apiKey, model) : new AnthropicProvider(apiKey, model);
}
