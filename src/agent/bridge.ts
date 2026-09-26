// Frontend half of the MCP localhost bridge. The Rust listener forwards each
// external tool call as an "mcp://call" event; we run it through the SAME tool
// registry (so external clients and the in-app agent never diverge) and answer
// via the mcp_bridge_reply command.
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { toolByName, splitDataUrl, type AgentCtx, type ToolResult } from "./tools";
import { mcpToolsList } from "./mcpManifest";

// ToolResult -> MCP content blocks the proxy passes straight through.
function toMcp(r: ToolResult) {
  if (!r.image) return { content: [{ type: "text", text: r.text ?? "ok" }], isError: !!r.isError };
  const { mime, data } = splitDataUrl(r.image);
  return { content: [{ type: "image", data, mimeType: mime }], isError: !!r.isError };
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
