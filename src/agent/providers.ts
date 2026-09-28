// Provider adapters behind one interface. The orchestrator speaks a neutral
// turn history; each adapter serialises it to its own API shape and parses the
// reply back. Two real implementations (Claude, DeepSeek) so the interface earns
// its keep. BYO key, direct browser calls (CSP is open).
import { splitDataUrl, type ToolDef, type ToolResult } from "./tools";

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}
// Neutral conversation turns the loop keeps and replays through any provider.
// `raw`, when present (Anthropic only), is the exact content-block array the
// API returned for that turn — see AnthropicProvider.chat for why this has to
// be replayed unmodified rather than rebuilt from text+toolCalls.
export type AgentTurn =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; raw?: unknown[] }
  | { role: "tool"; results: { id: string; result: ToolResult }[] };

export interface Usage {
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

export interface AssistantReply {
  text: string;
  toolCalls: ToolCall[];
  raw?: unknown[];
  usage?: Usage;
}

export interface AgentProvider {
  /** One model turn: given the history + tools, return text + any tool calls. */
  chat(system: string, history: AgentTurn[], tools: ToolDef[], signal?: AbortSignal): Promise<AssistantReply>;
}

export type ProviderId = "anthropic" | "deepseek";

export const MODELS: Record<ProviderId, { label: string; models: string[] }> = {
  anthropic: { label: "Anthropic (Claude)", models: ["claude-opus-5-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"] },
  deepseek: { label: "DeepSeek", models: ["deepseek-chat", "deepseek-reasoner"] },
};

// USD per MTok, checked against platform.claude.com/docs/en/about-claude/pricing on
// 2026-09-26. ponytail: feeds an *estimate* in the Scenario panel log only, never a
// bill — revisit if Anthropic reprices these models.
const ANTHROPIC_PRICING: Record<string, { in: number; cacheWrite: number; cacheRead: number; out: number }> = {
  "claude-opus-5-5": { in: 4, cacheWrite: 5, cacheRead: 0.2, out: 20 },
  "claude-sonnet-5": { in: 2, cacheWrite: 2.5, cacheRead: 0.2, out: 10 },
  "claude-haiku-4-5-20251001": { in: 1, cacheWrite: 1.25, cacheRead: 0.1, out: 5 },
};

/** Estimated USD for one turn's usage, or null if this model/provider has no
 *  known price (DeepSeek — not asked for; an unrecognised Anthropic model id). */
export function estimateCostUsd(provider: ProviderId, model: string, u: Usage): number | null {
  if (provider !== "anthropic") return null;
  const p = ANTHROPIC_PRICING[model];
  if (!p) return null;
  return (u.inputTokens * p.in + u.cacheWriteTokens * p.cacheWrite + u.cacheReadTokens * p.cacheRead + u.outputTokens * p.out) / 1_000_000;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("aborted", "AbortError")); }, { once: true });
  });
}

/** Both providers' APIs are OpenAI/Anthropic-style: 429 (rate limit) and 529
 *  (overloaded) are the two transient statuses worth a retry. Honours
 *  Retry-After when the server sends one, else exponential backoff. */
async function fetchWithRetry(url: string, init: RequestInit, signal: AbortSignal | undefined, maxRetries = 4): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { ...init, signal });
    if (res.status !== 429 && res.status !== 529) return res;
    if (attempt >= maxRetries) return res;
    const retryAfter = Number(res.headers.get("retry-after"));
    const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
    await sleep(delayMs, signal);
  }
}

// --- Anthropic (native tool use + vision) ---
class AnthropicProvider implements AgentProvider {
  constructor(private apiKey: string, private model: string) {}

  async chat(system: string, history: AgentTurn[], tools: ToolDef[], signal?: AbortSignal): Promise<AssistantReply> {
    const messages = history.map((t) => {
      if (t.role === "user") return { role: "user", content: t.text };
      if (t.role === "assistant") {
        // Opus 5.5/Sonnet 5 think by default (display "omitted": empty `thinking`
        // text, real `signature`) even with no `thinking` param — every assistant
        // turn's content array includes thinking blocks. The API requires those
        // blocks to be replayed back byte-for-byte once a tool_result follows them
        // in the same turn (a tool-use loop is one assistant turn); rebuilding the
        // turn from just text+tool_use drops them and the next request 400s. So:
        // replay the raw content we got back, don't reconstruct it.
        if (t.raw) return { role: "assistant", content: t.raw };
        const content: unknown[] = [];
        if (t.text) content.push({ type: "text", text: t.text });
        for (const c of t.toolCalls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
        return { role: "assistant", content };
      }
      return {
        role: "user",
        content: t.results.map(({ id, result }) => {
          const blocks: unknown[] = [];
          if (result.text) blocks.push({ type: "text", text: result.text });
          if (result.image) {
            const { mime, data } = splitDataUrl(result.image);
            blocks.push({ type: "image", source: { type: "base64", media_type: mime, data } });
          }
          if (blocks.length === 0) blocks.push({ type: "text", text: "ok" });
          return { type: "tool_result", tool_use_id: id, content: blocks, is_error: result.isError };
        }),
      };
    });
    const res = await fetchWithRetry(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 16000,
          // Automatic caching: one top-level flag, the API manages breakpoints as
          // the (append-only) history grows — cheaper than hand-placed
          // per-block breakpoints for a loop shaped like this one.
          cache_control: { type: "ephemeral" },
          system,
          tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
          messages,
        }),
      },
      signal,
    );
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    const data = (await res.json()) as {
      content: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];
      usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number };
    };
    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const b of data.content) {
      if (b.type === "text" && b.text) text += b.text;
      else if (b.type === "tool_use") toolCalls.push({ id: b.id!, name: b.name!, input: b.input ?? {} });
    }
    const u = data.usage;
    const usage: Usage | undefined = u && {
      inputTokens: u.input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
    };
    return { text: text.trim(), toolCalls, raw: data.content, usage };
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
        for (const { id, result } of t.results) {
          const imageNote = result.image ? "[preview rendered; image not shown to this text-only model — judge by the timeline metadata]" : undefined;
          const content = [result.text, imageNote].filter(Boolean).join("\n") || "ok";
          messages.push({ role: "tool", tool_call_id: id, content });
        }
    }
    const res = await fetchWithRetry(
      "https://api.deepseek.com/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, max_tokens: 4096, messages, tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })) }),
      },
      signal,
    );
    if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    const data = (await res.json()) as {
      choices: { message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number };
    };
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
    const u = data.usage;
    const usage: Usage | undefined = u && {
      inputTokens: (u.prompt_tokens ?? 0) - (u.prompt_cache_hit_tokens ?? 0),
      cacheWriteTokens: 0,
      cacheReadTokens: u.prompt_cache_hit_tokens ?? 0,
      outputTokens: u.completion_tokens ?? 0,
    };
    return { text: (msg.content ?? "").trim(), toolCalls, usage };
  }
}

export function makeProvider(id: ProviderId, apiKey: string, model: string): AgentProvider {
  return id === "deepseek" ? new DeepSeekProvider(apiKey, model) : new AnthropicProvider(apiKey, model);
}
