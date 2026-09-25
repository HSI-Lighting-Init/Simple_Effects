#!/usr/bin/env node
// Standalone MCP (stdio) server for Simple Effects — this is what Claude Desktop
// and the VS Code agent spawn. It is a thin PROXY: Simple Effects must be running
// and hosting its localhost bridge, which owns the real editing engine + renderer.
// Tool schemas and results come straight from the app, so there is no second copy
// of the engine here (the whole point).
//
// Bridge contract (served by the app on SIMPLE_EFFECTS_MCP_URL, default :8787):
//   GET  /mcp/tools        -> { tools: [{ name, description, inputSchema }] }
//   POST /mcp/call {name, arguments} -> { content: [ {type:"text",text} | {type:"image",data(base64),mimeType} ], isError? }
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const BASE = process.env.SIMPLE_EFFECTS_MCP_URL || "http://127.0.0.1:8787";

async function bridge(path, init) {
  let res;
  try {
    res = await fetch(BASE + path, init);
  } catch {
    throw new Error(`Simple Effects isn't reachable at ${BASE}. Open the app and enable Templates → AI: Enable MCP bridge.`);
  }
  if (!res.ok) throw new Error(`bridge ${path} -> ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  return res.json();
}

const server = new Server({ name: "simple-effects", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const { tools } = await bridge("/mcp/tools");
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const out = await bridge("/mcp/call", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: req.params.name, arguments: req.params.arguments ?? {} }),
  });
  // The app already returns MCP-shaped content blocks; pass them through.
  return { content: out.content ?? [{ type: "text", text: "ok" }], isError: out.isError };
});

await server.connect(new StdioServerTransport());
