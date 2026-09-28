// Frontend half of the MCP localhost bridge. The Rust listener forwards each
// external tool call as an "mcp://call" event; we run it through the SAME tool
// registry (so external clients and the in-app agent never diverge) and answer
// via the mcp_bridge_reply command.
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { toolByName, splitDataUrl, type AgentCtx, type ToolResult } from "./tools";
import { mcpToolsList } from "./mcpManifest";

// ToolResult -> MCP content blocks the proxy passes straight through. Text and
// an image can both be present (e.g. audit_export's report + suspect sheet) —
// MCP tool results support multiple content blocks, so send both rather than
// dropping whichever one loses.
function toMcp(r: ToolResult) {
  const content: unknown[] = [];
  if (r.text) content.push({ type: "text", text: r.text });
  if (r.image) {
    const { mime, data } = splitDataUrl(r.image);
    content.push({ type: "image", data, mimeType: mime });
  }
  if (content.length === 0) content.push({ type: "text", text: "ok" });
  return { content, isError: !!r.isError };
}

let listening = false;

/** Start (or re-arm) the bridge: hand Rust the manifest + port, and once wire the
 *  event listener that dispatches tool calls against `ctx`. Safe to call again. */
export async function startMcpBridge(ctx: AgentCtx, port = 8787): Promise<void> {
  await invoke("mcp_bridge_start", { port, manifest: JSON.stringify(mcpToolsList()) });
  if (listening) return;
  listening = true;
  await listen<{ reqId: number; name: string; args: Record<string, unknown> }>("mcp://call", async (e) => {
    const { reqId, name, args } = e.payload;
    const tool = toolByName.get(name);
    let result: ToolResult;
    if (!tool) result = { text: `unknown tool ${name}`, isError: true };
    else {
      try {
        result = await tool.handler(args ?? {}, ctx);
      } catch (err) {
        result = { text: `tool error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    }
    await invoke("mcp_bridge_reply", { reqId, result: JSON.stringify(toMcp(result)) });
  });
}
