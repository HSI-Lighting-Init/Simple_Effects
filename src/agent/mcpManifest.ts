// The MCP `tools/list` payload, generated from the one tool registry so the
// external MCP server (Claude Desktop / VSCode) and the in-app agent never drift.
// The app's localhost bridge serves this; the standalone server just proxies it.
import { TOOLS } from "./tools";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function mcpToolsList(): { tools: McpTool[] } {
  return { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
}
